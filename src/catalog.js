"use strict";

const cheerio = require("cheerio");
const config = require("./config");
const { TTLCache, SingleFlight, withBudget, deadline } = require("./cache");
const { fetchText, fetchJson, mapWithConcurrency } = require("./http");
const {
  clean, absoluteUrl, slugFromUrl, isContentUrl, looksLikePost,
  cardImage, cardTitle, titleFromSlug, metaValue, pagePoster, cleanTitle
} = require("./parse");
const { resolvePlayers } = require("./resolver");

const catalogCache = new TTLCache(config.catalogCacheMs, config.catalogStaleMs);
const detailCache = new TTLCache(config.detailCacheMs, config.detailStaleMs);
const pageUrlCache = new TTLCache(24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const catalogFlight = new SingleFlight();
const detailFlight = new SingleFlight();

const status = {
  startedAt: new Date().toISOString(),
  categories: {},
  lastError: null
};

const CATEGORY_ALIASES = {
  novelas: ["novelas", "novela"],
  series: ["series", "serie", "séries", "série"],
  programas: ["programas", "programa"],
  shows: ["shows", "show"],
  filmes: ["filmes", "filme", "movies", "movie"]
};

function categoryByKey(key) {
  return config.categories.find((category) => category.key === key) || null;
}
function metaId(categoryKey, slug) {
  return `noveflix:${categoryKey}-${slug}`;
}
function statusFor(key) {
  if (!status.categories[key]) {
    status.categories[key] = { items: 0, source: null, updatedAt: null, lastError: null, refreshing: false, pages: 0 };
  }
  return status.categories[key];
}

function makeItem(category, slug, extra = {}) {
  const name = clean(extra.name) || titleFromSlug(slug);
  return {
    id: metaId(category.key, slug),
    category: category.key,
    slug,
    pageUrl: extra.pageUrl || new URL(`/${config.contentPathPrefixes[0]}/${slug}/`, config.siteBase).href,
    type: category.type,
    episodic: category.episodic,
    name,
    poster: extra.poster || null,
    background: extra.background || extra.poster || null,
    description: clean(extra.description) || `Assista ${name} no NoveFlix.`,
    releaseInfo: extra.releaseInfo || null,
    genres: [category.genre]
  };
}

function rememberPageUrl(slug, pageUrl) {
  if (slug && pageUrl) pageUrlCache.set(slug, pageUrl);
}

function seedItems(category) {
  return config.seeds
    .filter((seed) => seed.category === category.key)
    .map((seed) => makeItem(category, seed.slug, seed));
}

function mergeItems(target, items) {
  for (const item of items) {
    if (!item?.slug) continue;
    const existing = target.get(item.slug);
    if (!existing) {
      target.set(item.slug, item);
      continue;
    }
    target.set(item.slug, {
      ...existing,
      name: existing.name.length >= item.name.length ? existing.name : item.name,
      poster: existing.poster || item.poster,
      background: existing.background || item.background,
      description: existing.description || item.description,
      releaseInfo: existing.releaseInfo || item.releaseInfo,
      pageUrl: existing.pageUrl || item.pageUrl
    });
  }
  return target;
}

/* --------------------------------------------------------------------------
 * Origem 1: REST do WordPress (rápida, estável e imune a mudança de tema)
 * ------------------------------------------------------------------------ */

function restBase() {
  return `${config.siteBase}/wp-json/wp/v2`;
}

async function restCategoryId(category, timeout) {
  const cacheKey = `rest-category:${category.key}`;
  const cached = pageUrlCache.get(cacheKey);
  if (cached) return cached;

  for (const alias of CATEGORY_ALIASES[category.key] || [category.key]) {
    try {
      const entries = await fetchJson(
        `${restBase()}/categories?slug=${encodeURIComponent(alias)}&_fields=id,slug,count&per_page=10`,
        { timeout }
      );
      const match = Array.isArray(entries) ? entries.find((entry) => entry?.id) : null;
      if (match) return pageUrlCache.set(cacheKey, match.id);
    } catch {}
  }
  return null;
}

function restPoster(entry) {
  const embedded = entry?._embedded?.["wp:featuredmedia"]?.[0];
  const sizes = embedded?.media_details?.sizes || {};
  const preferred = sizes.full || sizes.large || sizes.medium_large || sizes.medium;
  return entry?.jetpack_featured_media_url || preferred?.source_url || embedded?.source_url || null;
}

function restItem(category, entry) {
  const link = entry?.link || "";
  const slug = clean(entry?.slug) || slugFromUrl(link);
  if (!slug) return null;
  rememberPageUrl(slug, link || undefined);
  return makeItem(category, slug, {
    name: cleanTitle(entry?.title?.rendered || slug),
    pageUrl: link || undefined,
    poster: restPoster(entry),
    description: clean(String(entry?.excerpt?.rendered || "").replace(/<[^>]*>/g, "")),
    releaseInfo: String(entry?.date || "").slice(0, 4) || null
  });
}

async function restCatalog(category, budget) {
  const timeout = Math.min(config.requestTimeoutMs, Math.max(3000, budget.remaining()));
  const categoryId = await restCategoryId(category, timeout);
  if (!categoryId) return [];

  const fields = "id,slug,link,title,excerpt,date,jetpack_featured_media_url,_links";
  const perPage = 100;
  const found = new Map();
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, config.maxCatalogPages); page += 1) {
    if (budget.expired()) break;
    const url = `${restBase()}/posts?categories=${categoryId}&per_page=${perPage}&page=${page}` +
      `&_embed=wp:featuredmedia&_fields=${fields},_embedded&orderby=title&order=asc`;
    let response;
    try {
      response = await fetchText(url, {
        timeout: Math.min(config.requestTimeoutMs, Math.max(3000, budget.remaining())),
        headers: { accept: "application/json" }
      });
    } catch (error) {
      if (page === 1) throw error;
      break;
    }

    if (page === 1) {
      const header = Number(response.headers?.get?.("x-wp-totalpages") || 1);
      if (Number.isFinite(header) && header > 0) totalPages = header;
    }

    let entries;
    try { entries = JSON.parse(response.text); } catch { break; }
    if (!Array.isArray(entries) || !entries.length) break;

    const items = entries.map((entry) => restItem(category, entry)).filter(Boolean);
    const before = found.size;
    mergeItems(found, items);
    if (found.size === before) break;
  }

  return [...found.values()];
}

/* --------------------------------------------------------------------------
 * Origem 2: HTML do arquivo da categoria (fallback)
 * ------------------------------------------------------------------------ */

function archiveUrls(category) {
  const paths = [category.path, `/category/${category.key}/`, `/${category.key}/`];
  return [...new Set(paths.map((path) => new URL(path, config.siteBase).href))];
}

function pageUrlFor(archiveUrl, pageNumber) {
  if (pageNumber === 1) return archiveUrl;
  return `${archiveUrl.replace(/\/$/, "")}/page/${pageNumber}/`;
}

function extractListing($, category, baseUrl) {
  const strict = [];
  const loose = [];

  $("a[href]").each((_, anchor) => {
    const url = absoluteUrl($(anchor).attr("href"), baseUrl);
    if (!url) return;
    if (isContentUrl(url)) {
      strict.push({ anchor, url });
      return;
    }
    if (!looksLikePost(url)) return;
    const node = $(anchor);
    const hasImage = node.find("img").length > 0 || node.closest("article,.post,.item,.card,.entry").find("img").length > 0;
    if (hasImage) loose.push({ anchor, url });
  });

  const chosen = strict.length ? strict : loose;
  const items = [];
  for (const entry of chosen) {
    const slug = slugFromUrl(entry.url);
    if (!slug) continue;
    rememberPageUrl(slug, entry.url);
    items.push(makeItem(category, slug, {
      name: cardTitle($, entry.anchor, slug),
      pageUrl: entry.url,
      poster: cardImage($, entry.anchor, baseUrl)
    }));
  }
  return items;
}

async function htmlCatalog(category, budget) {
  const found = new Map();

  for (const archiveUrl of archiveUrls(category)) {
    if (budget.expired()) break;
    let pageNumber = 1;
    let stopped = false;

    while (!stopped && pageNumber <= config.maxCatalogPages && !budget.expired()) {
      const batch = [];
      for (let offset = 0; offset < config.catalogPageConcurrency && pageNumber + offset <= config.maxCatalogPages; offset += 1) {
        batch.push(pageNumber + offset);
      }

      const results = await mapWithConcurrency(batch, config.catalogPageConcurrency, async (number) => {
        const response = await fetchText(pageUrlFor(archiveUrl, number), {
          timeout: Math.min(config.requestTimeoutMs, Math.max(3000, budget.remaining())),
          retries: number === 1 ? config.requestRetries : 1
        });
        const $ = cheerio.load(response.text);
        return { number, items: extractListing($, category, response.finalUrl) };
      });

      for (const result of results) {
        if (!result || result.error || !result.items?.length) { stopped = true; break; }
        const before = found.size;
        mergeItems(found, result.items);
        statusFor(category.key).pages = Math.max(statusFor(category.key).pages, result.number);
        if (found.size === before) { stopped = true; break; }
      }
      pageNumber += batch.length;
    }

    if (found.size) break;
  }

  return [...found.values()];
}

/* --------------------------------------------------------------------------
 * Catálogo com cache "stale-while-revalidate"
 * ------------------------------------------------------------------------ */

function sortItems(items) {
  return items.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function refreshCategory(category, budgetMs) {
  const budget = deadline(budgetMs);
  const state = statusFor(category.key);
  state.refreshing = true;
  const found = new Map();
  let source = null;

  try {
    try {
      const restItems = await restCatalog(category, budget);
      if (restItems.length) {
        source = "wp-rest";
        mergeItems(found, restItems);
      }
    } catch (error) {
      state.lastError = `REST: ${error.message}`;
    }

    if (!found.size) {
      try {
        const htmlItems = await htmlCatalog(category, budget);
        if (htmlItems.length) {
          source = "html";
          mergeItems(found, htmlItems);
        }
      } catch (error) {
        state.lastError = `HTML: ${error.message}`;
      }
    }

    const previous = catalogCache.peek(category.key)?.value || [];
    if (!found.size && previous.length) {
      state.source = state.source || "cache";
      return previous;
    }

    mergeItems(found, seedItems(category));
    const items = sortItems([...found.values()]);

    state.items = items.length;
    state.source = source || (items.length ? "seeds" : "vazio");
    state.updatedAt = new Date().toISOString();
    if (source) state.lastError = null;
    console.log(`${category.name}: ${items.length} itens (${state.source}).`);

    return catalogCache.set(category.key, items);
  } finally {
    state.refreshing = false;
  }
}

function backgroundRefresh(category, budgetMs = config.catalogDeepBudgetMs) {
  if (catalogFlight.has(category.key)) return;
  catalogFlight
    .run(category.key, () => refreshCategory(category, budgetMs))
    .catch((error) => {
      statusFor(category.key).lastError = error.message;
      status.lastError = `${category.key}: ${error.message}`;
    });
}

/**
 * Nunca bloqueia além do orçamento: devolve cache fresco, cache expirado ou
 * o que a varredura conseguiu montar até o prazo, e continua atualizando.
 */
async function getCategoryItems(category, budgetMs = config.catalogBudgetMs) {
  const cached = catalogCache.peek(category.key);
  if (cached?.fresh) return cached.value;
  if (cached) {
    backgroundRefresh(category);
    return cached.value;
  }

  const work = catalogFlight.run(category.key, () => refreshCategory(category, config.catalogDeepBudgetMs));
  const items = await withBudget(work, budgetMs, () =>
    catalogCache.peek(category.key)?.value || seedItems(category)
  );
  return items;
}

function warmup() {
  if (!config.warmup) return;
  for (const category of config.categories) backgroundRefresh(category);
}

/* --------------------------------------------------------------------------
 * Detalhes de um item
 * ------------------------------------------------------------------------ */

async function findPageUrl(categoryKey, slug, budget) {
  const cached = pageUrlCache.get(slug);
  if (cached) return cached;

  const timeout = Math.min(config.requestTimeoutMs, Math.max(2500, budget.remaining()));

  try {
    const entries = await fetchJson(
      `${restBase()}/posts?slug=${encodeURIComponent(slug)}&_fields=link,slug&per_page=5`,
      { timeout }
    );
    const link = Array.isArray(entries) ? entries.find((entry) => entry?.link)?.link : null;
    if (link) {
      rememberPageUrl(slug, link);
      return link;
    }
  } catch {}

  const catalog = catalogCache.peek(categoryKey)?.value || [];
  const known = catalog.find((item) => item.slug === slug)?.pageUrl;
  if (known) return known;

  const candidates = [
    ...config.contentPathPrefixes.map((prefix) => new URL(`/${prefix}/${slug}/`, config.siteBase).href),
    new URL(`/${slug}/`, config.siteBase).href
  ];

  for (const candidate of candidates) {
    if (budget.expired()) break;
    try {
      const response = await fetchText(candidate, { timeout, retries: 1 });
      rememberPageUrl(slug, response.finalUrl);
      return response.finalUrl;
    } catch {}
  }

  return new URL(`/${config.contentPathPrefixes[0]}/${slug}/`, config.siteBase).href;
}

async function buildDetails(categoryKey, slug, { budgetMs, deep }) {
  const category = categoryByKey(categoryKey);
  const budget = deadline(budgetMs);
  const key = `${categoryKey}-${slug}`;

  const catalog = catalogCache.peek(categoryKey)?.value || [];
  const base = catalog.find((entry) => entry.slug === slug) || makeItem(category, slug);
  const previous = detailCache.peek(key)?.value;
  let item = { ...base, players: previous?.players || [] };

  const pageUrl = await findPageUrl(categoryKey, slug, budget);
  item.pageUrl = pageUrl;

  try {
    const response = await fetchText(pageUrl, {
      timeout: Math.min(config.requestTimeoutMs, Math.max(2500, budget.remaining())),
      retries: 1
    });
    const $ = cheerio.load(response.text);
    const name = cleanTitle(
      metaValue($, ["meta[property='og:title']", "meta[name='twitter:title']"]) || $("h1").first().text() || base.name
    );
    item = {
      ...item,
      pageUrl: response.finalUrl,
      name: name || base.name,
      description: clean(
        metaValue($, ["meta[property='og:description']", "meta[name='description']"]) ||
        $(".sinopse,.synopsis,.description,.entry-content p").first().text() ||
        base.description
      ),
      poster: pagePoster($, response.finalUrl) || base.poster,
      releaseInfo: clean(response.text).match(/(?:19|20)\d{2}/)?.[0] || base.releaseInfo
    };
    item.background = item.poster || base.background;
    rememberPageUrl(slug, response.finalUrl);
  } catch (error) {
    console.warn(`Detalhes parciais para ${key}: ${error.message}`);
  }

  const players = await resolvePlayers(item.pageUrl, key, {
    budgetMs: Math.max(2000, budget.remaining()),
    deep
  });
  if (players.length) item.players = players;

  if (item.players.length) {
    console.log(`Players ${key}: ${item.players.map((player) => `T${player.season || 1}/${player.code || "media"}/${player.latestEpisode || 1}`).join(" | ")}`);
  } else {
    console.warn(`Player não localizado: ${key}`);
  }

  return detailCache.set(key, item);
}

/**
 * Detalhes com orçamento: o handler responde rápido com o que existir e a
 * resolução completa (inclusive navegador) continua em segundo plano.
 */
async function getDetails(categoryKey, slug, { budgetMs = config.metaBudgetMs, deep = false } = {}) {
  const category = categoryByKey(categoryKey);
  if (!category) throw new Error(`Categoria inválida: ${categoryKey}`);
  const key = `${categoryKey}-${slug}`;
  const cached = detailCache.peek(key);

  if (cached?.fresh && (!deep || cached.value.players?.length)) return cached.value;

  const flightKey = deep ? `deep:${key}` : key;
  const work = detailFlight.run(flightKey, () =>
    buildDetails(categoryKey, slug, { budgetMs: deep ? config.streamBudgetMs : config.catalogDeepBudgetMs, deep })
  );
  work.catch((error) => console.error(`Detalhes ${key}: ${error.message}`));

  const fallback = () => cached?.value || { ...makeItem(category, slug), players: [] };
  const item = await withBudget(work, budgetMs, fallback);
  return item || fallback();
}

module.exports = {
  categoryByKey,
  metaId,
  makeItem,
  getCategoryItems,
  getDetails,
  backgroundRefresh,
  warmup,
  status,
  caches: { catalogCache, detailCache, pageUrlCache }
};
