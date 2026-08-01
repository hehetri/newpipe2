"use strict";

const cheerio = require("cheerio");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const config = require("./config");
const { TTLCache } = require("./cache");
const { fetchText } = require("./http");
const { resolvePlayer, episodeUrl } = require("./resolver");

const catalogCache = new TTLCache(config.catalogCacheMs);
const detailCache = new TTLCache(config.detailCacheMs);
const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();

function absoluteUrl(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}
function slugFromUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.at(-1) || "").toLowerCase();
  } catch { return ""; }
}
function isContentUrl(value) {
  try { return /\/(?:assista|assistir|assistir-[^/]+)(?:\/|$)/i.test(new URL(value).pathname); }
  catch { return false; }
}
function metaId(category, slug) { return `noveflix:${category}-${slug}`; }
function episodeId(item, episode) { return `${item.id}:1:${episode}`; }
function parseId(id) {
  const parts = String(id).split(":");
  if (parts[0] !== "noveflix" || !parts[1]) return null;
  const dash = parts[1].indexOf("-");
  if (dash < 1) return null;
  return { category: parts[1].slice(0, dash), slug: parts[1].slice(dash + 1), season: Number(parts[2]), episode: Number(parts[3]) };
}
function categoryByKey(key) { return config.categories.find((item) => item.key === key) || null; }

function cardTitle($, anchor, slug) {
  const node = $(anchor), image = node.find("img").first();
  return clean(image.attr("alt") || image.attr("title") || node.attr("title") || node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() || node.text() || slug.replace(/-/g, " "));
}
function cardImage($, anchor, base) {
  const image = $(anchor).find("img").first();
  return absoluteUrl(image.attr("data-src") || image.attr("data-lazy-src") || image.attr("data-original") || image.attr("src"), base);
}

async function scrapeCategory(category) {
  const cached = catalogCache.get(category.key);
  if (cached) return cached;
  const found = new Map();
  const baseUrl = new URL(category.path, config.siteBase).href;
  for (let pageNumber = 1; pageNumber <= config.maxCatalogPages; pageNumber += 1) {
    const url = pageNumber === 1 ? baseUrl : `${baseUrl.replace(/\/$/, "")}/page/${pageNumber}/`;
    let response;
    try { response = await fetchText(url); }
    catch (error) { if (pageNumber === 1) console.error(`Catálogo ${category.key}: ${error.message}`); break; }
    const $ = cheerio.load(response.text);
    let added = 0;
    $("a[href]").each((_, anchor) => {
      const pageUrl = absoluteUrl($(anchor).attr("href"), response.finalUrl);
      if (!pageUrl || !isContentUrl(pageUrl)) return;
      const slug = slugFromUrl(pageUrl);
      if (!slug) return;
      const existing = found.get(slug);
      const name = cardTitle($, anchor, slug);
      const poster = cardImage($, anchor, response.finalUrl);
      found.set(slug, {
        id: metaId(category.key, slug), category: category.key, slug, pageUrl,
        type: category.type, episodic: category.episodic,
        name: existing?.name && existing.name.length > name.length ? existing.name : name,
        poster: existing?.poster || poster, background: existing?.background || poster,
        description: existing?.description || `Assista ${name} no NoveFlix.`, genres: [category.genre]
      });
      if (!existing) added += 1;
    });
    if (!added) break;
  }
  const items = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  console.log(`${category.name}: ${items.length} itens.`);
  return catalogCache.set(category.key, items);
}

function metaValue($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = node.attr("content") || node.attr("href") || node.attr("src");
    if (value) return clean(value);
  }
  return null;
}
function cleanTitle(title) {
  return clean(title).replace(/^Assistir\s+/i, "").replace(/\s+Online(?:\s+Grátis)?(?:\s+HD)?$/i, "").replace(/\s*[|–-]\s*NoveFlix.*$/i, "");
}

async function loadDetails(categoryKey, slug) {
  const key = `${categoryKey}-${slug}`;
  const cached = detailCache.get(key);
  if (cached) return cached;
  const category = categoryByKey(categoryKey);
  if (!category) throw new Error(`Categoria inválida: ${categoryKey}`);
  const catalog = await scrapeCategory(category);
  const base = catalog.find((item) => item.slug === slug);
  if (!base) throw new Error(`Conteúdo não encontrado: ${key}`);

  let item = { ...base, player: null };
  try {
    const response = await fetchText(base.pageUrl);
    const $ = cheerio.load(response.text);
    item = {
      ...item,
      name: cleanTitle(metaValue($, ["meta[property='og:title']", "meta[name='twitter:title']"]) || $("h1").first().text() || base.name),
      description: clean(metaValue($, ["meta[property='og:description']", "meta[name='description']"]) || $(".sinopse,.synopsis,.description,.entry-content p").first().text() || base.description),
      poster: absoluteUrl(metaValue($, ["meta[property='og:image']", "meta[name='twitter:image']", "link[rel='image_src']"]) || base.poster, response.finalUrl),
      releaseInfo: clean(response.text).match(/(?:19|20)\d{2}/)?.[0]
    };
    item.background = item.poster || base.background;
  } catch (error) {
    console.warn(`Detalhes parciais para ${key}: ${error.message}`);
  }

  item.player = await resolvePlayer(base.pageUrl, key);
  if (item.player) console.log(`Player ${key}: ${item.player.code || "media"} / ${item.player.latestEpisode || 1}`);
  else console.warn(`Player não localizado: ${key}`);
  return detailCache.set(key, item);
}

function toMeta(item) {
  return {
    id: item.id, type: item.type, name: item.name,
    poster: item.poster || config.defaultPoster, posterShape: "poster",
    background: item.background || item.poster || config.defaultPoster,
    description: item.description || `Assista ${item.name} no NoveFlix.`,
    genres: item.genres || [], releaseInfo: item.releaseInfo
  };
}
function buildVideos(item) {
  if (!item.episodic || !item.player?.latestEpisode) return [];
  return Array.from({ length: item.player.latestEpisode }, (_, index) => {
    const episode = index + 1;
    return { id: episodeId(item, episode), title: `Episódio ${episode}`, season: 1, episode, released: new Date(Date.UTC(2020, 0, 1 + episode)).toISOString() };
  });
}

const manifest = {
  id: "com.noveflix.catalog.clean",
  version: "4.0.0",
  name: "NoveFlix",
  description: "Catálogo automático NoveFlix com resolvedor de player",
  logo: config.defaultPoster,
  background: config.defaultPoster,
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["noveflix:"],
  behaviorHints: { configurable: false, configurationRequired: false, newEpisodeNotifications: true },
  catalogs: config.categories.map((category) => ({
    type: category.type, id: `noveflix-${category.key}`, name: category.name,
    pageSize: config.pageSize,
    extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
  }))
};

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  const category = config.categories.find((item) => item.type === type && `noveflix-${item.key}` === id);
  if (!category) return { metas: [] };
  try {
    let items = await scrapeCategory(category);
    const search = clean(extra.search).toLocaleLowerCase("pt-BR");
    if (search) items = items.filter((item) => item.name.toLocaleLowerCase("pt-BR").includes(search));
    const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
    return { metas: items.slice(skip, skip + config.pageSize).map(toMeta) };
  } catch (error) {
    console.error(`Catalog ${category.key}: ${error.stack || error.message}`);
    return { metas: [] };
  }
});
builder.defineMetaHandler(async ({ type, id }) => {
  const parsed = parseId(id), category = parsed && categoryByKey(parsed.category);
  if (!parsed || !category || category.type !== type) return { meta: null };
  try {
    const item = await loadDetails(parsed.category, parsed.slug);
    const meta = toMeta(item);
    if (item.episodic) meta.videos = buildVideos(item);
    return { meta };
  } catch (error) {
    console.error(`Meta ${id}: ${error.stack || error.message}`);
    return { meta: null };
  }
});
builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseId(id), category = parsed && categoryByKey(parsed.category);
  if (!parsed || !category || category.type !== type) return { streams: [] };
  try {
    const item = await loadDetails(parsed.category, parsed.slug);
    if (!item.player) return { streams: [] };
    if (!item.episodic) {
      return { streams: [{ name: "NoveFlix", title: item.name, url: item.player.mediaUrl || episodeUrl(item.player, item.player.currentEpisode || 1) }] };
    }
    if (!Number.isInteger(parsed.episode) || parsed.episode < 1 || parsed.episode > item.player.latestEpisode) return { streams: [] };
    return { streams: [{ name: "NoveFlix", title: `${item.name} — Episódio ${parsed.episode}`, url: episodeUrl(item.player, parsed.episode), behaviorHints: { bingeGroup: `${item.id}:season:1` } }] };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 4.0.0 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
