"use strict";

const cheerio = require("cheerio");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const config = require("./config");
const { TTLCache } = require("./cache");
const { fetchText } = require("./http");
const { resolvePlayers, episodeUrl } = require("./resolver");

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
  try {
    return /^\/(?:assista|assistir|assistir-[^/]+|assistir-online|ver)(?:\/|$)/i.test(new URL(value).pathname);
  } catch { return false; }
}
function metaId(category, slug) { return `noveflix:${category}-${slug}`; }
function episodeId(item, season, episode) { return `${item.id}:${season}:${episode}`; }
function parseId(id) {
  const parts = String(id).split(":");
  if (parts[0] !== "noveflix" || !parts[1]) return null;
  const dash = parts[1].indexOf("-");
  if (dash < 1) return null;
  return {
    category: parts[1].slice(0, dash),
    slug: parts[1].slice(dash + 1),
    season: parts[2] ? Number(parts[2]) : null,
    episode: parts[3] ? Number(parts[3]) : null
  };
}
function categoryByKey(key) { return config.categories.find((item) => item.key === key) || null; }

function cardTitle($, anchor, slug) {
  const node = $(anchor), image = node.find("img").first();
  return clean(
    image.attr("alt") || image.attr("title") || node.attr("title") ||
    node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() ||
    node.text() || slug.replace(/-/g, " ")
  );
}
function cardImage($, anchor, base) {
  const image = $(anchor).find("img").first();
  return absoluteUrl(
    image.attr("data-src") || image.attr("data-lazy-src") ||
    image.attr("data-original") || image.attr("src"),
    base
  );
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
    catch (error) {
      if (pageNumber === 1) console.error(`Catálogo ${category.key}: ${error.message}`);
      break;
    }

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
        id: metaId(category.key, slug),
        category: category.key,
        slug,
        pageUrl,
        type: category.type,
        episodic: category.episodic,
        name: existing?.name && existing.name.length > name.length ? existing.name : name,
        poster: existing?.poster || poster,
        background: existing?.background || poster,
        description: existing?.description || `Assista ${name} no NoveFlix.`,
        genres: [category.genre]
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
  return clean(title)
    .replace(/^Assistir\s+/i, "")
    .replace(/\s+Online(?:\s+Grátis)?(?:\s+HD)?$/i, "")
    .replace(/\s*[|–-]\s*NoveFlix.*$/i, "");
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

  let item = { ...base, players: [] };
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

  item.players = await resolvePlayers(base.pageUrl, key);
  if (item.players.length) {
    console.log(`Players ${key}: ${item.players.map((player) => `T${player.season || 1}/${player.code || "media"}/${player.latestEpisode || 1}`).join(" | ")}`);
  } else {
    console.warn(`Player não localizado: ${key}`);
  }
  return detailCache.set(key, item);
}

function toMeta(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster || config.defaultPoster,
    posterShape: "poster",
    background: item.background || item.poster || config.defaultPoster,
    description: item.description || `Assista ${item.name} no NoveFlix.`,
    genres: item.genres || [],
    releaseInfo: item.releaseInfo
  };
}

function buildVideos(item) {
  if (!item.episodic || !item.players.length) return [];
  const videos = new Map();
  for (const player of item.players) {
    const season = Math.max(1, Number(player.season || 1));
    const latest = player.kind === "single" ? 1 : Math.max(1, Number(player.latestEpisode || 1));
    for (let episode = 1; episode <= latest; episode += 1) {
      const id = episodeId(item, season, episode);
      if (!videos.has(id)) {
        videos.set(id, {
          id,
          title: `Episódio ${episode}`,
          season,
          episode,
          released: new Date(Date.UTC(Number(item.releaseInfo) || 2020, 0, Math.min(28, episode))).toISOString()
        });
      }
    }
  }
  return [...videos.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

const manifest = {
  id: "com.noveflix.addononly.v42",
  version: "4.2.0",
  name: "NoveFlix",
  description: "Catálogo NoveFlix com resolução automática de players, sem plugin externo.",
  logo: config.defaultPoster,
  background: config.defaultPoster,
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["noveflix:"],
  behaviorHints: { configurable: false, configurationRequired: false, newEpisodeNotifications: true },
  catalogs: config.categories.map((category) => ({
    type: category.type,
    id: `noveflix-${category.key}`,
    name: category.name,
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
    console.log(`Meta ${id}: ${meta.videos?.length || 0} episódios`);
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
    if (!item.players.length) return { streams: [] };

    if (!item.episodic) {
      return {
        streams: item.players.slice(0, 5).map((player, index) => ({
          name: "NoveFlix",
          title: index === 0 ? item.name : `${item.name} — Fonte ${index + 1}`,
          url: player.kind === "single" ? player.mediaUrl : episodeUrl(player, player.currentEpisode || player.latestEpisode || 1)
        }))
      };
    }

    if (!Number.isInteger(parsed.season) || !Number.isInteger(parsed.episode) || parsed.episode < 1) {
      return { streams: [] };
    }

    const matches = item.players.filter((player) => {
      const season = Number(player.season || 1);
      const latest = player.kind === "single" ? 1 : Number(player.latestEpisode || 0);
      return season === parsed.season && parsed.episode <= latest;
    });

    return {
      streams: matches.slice(0, 5).map((player, index) => ({
        name: "NoveFlix",
        title: index === 0
          ? `${item.name} — T${parsed.season} E${parsed.episode}`
          : `${item.name} — Fonte ${index + 1}`,
        url: player.kind === "single" ? player.mediaUrl : episodeUrl(player, parsed.episode),
        behaviorHints: { bingeGroup: `${item.id}:season:${parsed.season}` }
      }))
    };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 4.2.0 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
console.log("Modo: addon-only (sem plugin WordPress)");
