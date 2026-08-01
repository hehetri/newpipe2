"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const config = require("./lib/config");
const bridge = require("./lib/bridge-client");
const { resolvePlayers, episodeUrl } = require("./lib/media-resolver");
const { TTLCache } = require("./lib/cache");

const detailCache = new TTLCache(config.cacheMs);

function catalogId(category) {
  return `noveflix-${category.key}`;
}

function metaId(category, postId) {
  return `noveflix:${category}-${postId}`;
}

function parseStremioId(id) {
  const parts = String(id || "").split(":");
  if (parts[0] !== "noveflix" || !parts[1]) return null;
  const match = parts[1].match(/^([a-z0-9_-]+)-(\d+)$/i);
  if (!match) return null;
  return {
    category: match[1],
    postId: Number(match[2]),
    season: parts[2] ? Number(parts[2]) : null,
    episode: parts[3] ? Number(parts[3]) : null
  };
}

function categoryByKey(key) {
  return config.categories.find((category) => category.key === key) || null;
}

function toMeta(item) {
  const category = categoryByKey(item.category);
  return {
    id: metaId(item.category, item.id),
    type: item.type || category?.type || "series",
    name: item.title,
    poster: item.poster || config.defaultPoster,
    posterShape: "poster",
    background: item.background || item.poster || config.defaultBackground,
    description: item.description || `Assista ${item.title} no NoveFlix.`,
    genres: [item.genre || category?.genre || "NoveFlix"],
    releaseInfo: item.year ? String(item.year) : undefined,
    website: item.url || undefined
  };
}

async function loadItem(category, postId) {
  const key = `${category}:${postId}`;
  const cached = detailCache.get(key);
  if (cached) return cached;

  const item = await bridge.item(postId, category);
  const media = await resolvePlayers(item.players || []);
  const value = { ...item, media };
  return detailCache.set(key, value);
}

function buildVideos(item) {
  const videos = [];
  const patterns = item.media.filter((media) => media.kind === "pattern");

  for (const pattern of patterns) {
    const latest = Math.min(config.maxEpisodes, Math.max(1, Number(pattern.latestEpisode || 1)));
    for (let episode = 1; episode <= latest; episode += 1) {
      videos.push({
        id: `${metaId(item.category, item.id)}:${pattern.season || 1}:${episode}`,
        title: `Episódio ${episode}`,
        season: pattern.season || 1,
        episode,
        released: new Date(Date.UTC(Number(item.year) || 2020, 0, Math.min(28, episode))).toISOString()
      });
    }
  }

  return videos;
}

const manifest = {
  id: "com.noveflix.library.v4",
  version: "4.0.1",
  name: "NoveFlix",
  description: "Biblioteca autorizada do NoveFlix com catálogo, metadados e streams via API própria.",
  logo: config.defaultPoster,
  background: config.defaultBackground,
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  idPrefixes: ["noveflix:"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
    newEpisodeNotifications: true
  },
  catalogs: config.categories.map((category) => ({
    type: category.type,
    id: catalogId(category),
    name: category.name,
    pageSize: config.pageSize,
    extra: [
      { name: "search", isRequired: false },
      { name: "skip", isRequired: false }
    ]
  }))
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  const category = config.categories.find((entry) => entry.type === type && catalogId(entry) === id);
  if (!category) return { metas: [] };

  try {
    const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
    const page = Math.floor(skip / config.pageSize) + 1;
    const offset = skip % config.pageSize;
    const search = String(extra.search || "").trim();
    const result = await bridge.catalog(category.key, page, config.pageSize, search);
    const items = Array.isArray(result.items) ? result.items : [];
    return { metas: items.slice(offset).map(toMeta) };
  } catch (error) {
    console.error(`Catálogo ${category.key}: ${error.stack || error.message}`);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  const parsed = parseStremioId(id);
  const category = parsed && categoryByKey(parsed.category);
  if (!parsed || !category || category.type !== type) return { meta: null };

  try {
    const item = await loadItem(parsed.category, parsed.postId);
    const meta = toMeta(item);
    if (category.episodic) meta.videos = buildVideos(item);
    console.log(`Meta: ${id} (${meta.videos?.length || 0} episódios, ${item.media.length} fontes, ${item.player_count || 0} players brutos)`);
    return { meta };
  } catch (error) {
    console.error(`Meta ${id}: ${error.stack || error.message}`);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseStremioId(id);
  const category = parsed && categoryByKey(parsed.category);
  if (!parsed || !category || category.type !== type) return { streams: [] };

  try {
    const item = await loadItem(parsed.category, parsed.postId);

    if (!category.episodic) {
      const sources = item.media.filter((media) => media.kind === "single" || media.kind === "pattern");
      return {
        streams: sources.slice(0, 5).map((source, index) => ({
          name: "NoveFlix",
          title: index === 0 ? item.title : `${item.title} — Fonte ${index + 1}`,
          url: source.kind === "single" ? source.url : source.sampleUrl
        }))
      };
    }

    if (!Number.isInteger(parsed.season) || !Number.isInteger(parsed.episode) || parsed.episode < 1) {
      return { streams: [] };
    }

    const pattern = item.media.find((media) =>
      media.kind === "pattern" &&
      Number(media.season || 1) === parsed.season &&
      parsed.episode <= Number(media.latestEpisode || 0)
    );

    if (!pattern) return { streams: [] };

    return {
      streams: [{
        name: "NoveFlix",
        title: `${item.title} — T${parsed.season} E${parsed.episode}`,
        url: episodeUrl(pattern, parsed.episode),
        behaviorHints: { bingeGroup: `${metaId(item.category, item.id)}:season:${parsed.season}` }
      }]
    };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 4.0.1 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
console.log(`Bridge: ${config.bridgeUrl}`);

bridge.health()
  .then((result) => console.log(`Bridge OK: ${JSON.stringify(result.counts || result)}`))
  .catch((error) => console.error(`Bridge indisponível: ${error.message}`));
