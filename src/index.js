"use strict";

const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");

const config = require("./config");
const { titleFromSlug } = require("./parse");
const { episodeUrl } = require("./resolver");
const {
  categoryByKey, makeItem, getCategoryItems, getDetails, warmup, status, caches
} = require("./catalog");

const VERSION = require("../package.json").version;

function parseId(id) {
  const parts = String(id || "").split(":");
  if (parts[0] !== "noveflix" || !parts[1]) return null;
  const dash = parts[1].indexOf("-");
  if (dash < 1) return null;
  const category = parts[1].slice(0, dash);
  const slug = parts[1].slice(dash + 1);
  if (!slug) return null;
  return {
    category,
    slug,
    season: parts[2] !== undefined && parts[2] !== "" ? Number(parts[2]) : null,
    episode: parts[3] !== undefined && parts[3] !== "" ? Number(parts[3]) : null
  };
}

function toMeta(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster || config.defaultPoster,
    posterShape: "poster",
    background: item.background || item.poster || config.defaultPoster,
    logo: item.poster || config.defaultPoster,
    description: item.description || `Assista ${item.name} no NoveFlix.`,
    genres: item.genres || [],
    releaseInfo: item.releaseInfo || undefined
  };
}

function buildVideos(item) {
  if (!item.episodic) return [];
  const year = Number(item.releaseInfo) || new Date().getFullYear();
  const videos = new Map();

  for (const player of item.players || []) {
    const season = Math.max(1, Number(player.season || 1));
    const latest = player.kind === "single" ? 1 : Math.max(1, Number(player.latestEpisode || 1));
    for (let episode = 1; episode <= latest; episode += 1) {
      const id = `${item.id}:${season}:${episode}`;
      if (videos.has(id)) continue;
      videos.set(id, {
        id,
        title: `Episódio ${episode}`,
        season,
        episode,
        released: new Date(Date.UTC(year, 0, Math.min(28, episode))).toISOString()
      });
    }
  }

  // Sem player resolvido ainda: mantém um episódio para o usuário conseguir
  // abrir o item — a chamada de /stream dispara a resolução completa.
  if (!videos.size) {
    const id = `${item.id}:1:1`;
    videos.set(id, {
      id,
      title: "Episódio 1",
      season: 1,
      episode: 1,
      released: new Date(Date.UTC(year, 0, 1)).toISOString()
    });
  }

  return [...videos.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

const manifest = {
  // O id não muda: trocá-lo faria o Stremio tratar como outro addon e o
  // usuário perderia a biblioteca já instalada.
  id: "com.noveflix.addononly.v42",
  version: VERSION,
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

builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const key = String(id || "").replace(/^noveflix-/, "");
  const category = categoryByKey(key);
  if (!category) return { metas: [] };

  try {
    let items = await getCategoryItems(category);
    const search = String(extra.search || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
    if (search) {
      items = items.filter((item) =>
        item.name.toLocaleLowerCase("pt-BR").includes(search) || item.slug.includes(search.replace(/\s+/g, "-"))
      );
    }
    const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
    const metas = items.slice(skip, skip + config.pageSize).map(toMeta);
    return {
      metas,
      // Resposta vazia (varredura ainda em andamento) não fica presa no cache.
      cacheMaxAge: metas.length ? 30 * 60 : 60,
      staleRevalidate: 6 * 60 * 60,
      staleError: 7 * 24 * 60 * 60
    };
  } catch (error) {
    console.error(`Catalog ${key}: ${error.stack || error.message}`);
    return { metas: [], cacheMaxAge: 60 };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id);
  const category = parsed && categoryByKey(parsed.category);

  // Fallback imediato: o Stremio nunca recebe "meta: null".
  const fallbackMeta = () => {
    const name = titleFromSlug(parsed?.slug || "");
    return {
      id: String(id),
      type: category?.type || "series",
      name,
      poster: config.defaultPoster,
      posterShape: "poster",
      background: config.defaultPoster,
      description: `Assista ${name} no NoveFlix.`,
      genres: category ? [category.genre] : ["NoveFlix"]
    };
  };

  if (!parsed || !category) {
    return { meta: fallbackMeta(), cacheMaxAge: 60 };
  }

  try {
    const item = await getDetails(parsed.category, parsed.slug, { budgetMs: config.metaBudgetMs });
    const meta = toMeta(item);
    if (item.episodic) meta.videos = buildVideos(item);
    console.log(`Meta ${id}: ${meta.videos?.length || 0} episódios`);
    return {
      meta,
      cacheMaxAge: item.players?.length ? 60 * 60 : 60,
      staleRevalidate: 6 * 60 * 60,
      staleError: 24 * 60 * 60
    };
  } catch (error) {
    console.error(`Meta ${id}: ${error.stack || error.message}`);
    const meta = fallbackMeta();
    if (category.episodic) meta.videos = buildVideos({ ...makeItem(category, parsed.slug), players: [] });
    return { meta, cacheMaxAge: 60 };
  }
});

function streamsFor(item, parsed) {
  if (!item.players?.length) return [];

  if (!item.episodic) {
    return item.players.slice(0, 5).map((player, index) => ({
      name: "NoveFlix",
      title: index === 0 ? item.name : `${item.name} — Fonte ${index + 1}`,
      url: player.kind === "single" ? player.mediaUrl : episodeUrl(player, player.currentEpisode || player.latestEpisode || 1)
    }));
  }

  const season = Number.isInteger(parsed.season) ? parsed.season : 1;
  const episode = Number.isInteger(parsed.episode) && parsed.episode > 0 ? parsed.episode : 1;

  const exact = item.players.filter((player) => {
    const playerSeason = Number(player.season || 1);
    const latest = player.kind === "single" ? 1 : Number(player.latestEpisode || 0);
    return playerSeason === season && episode <= latest;
  });

  // Episódio ainda não catalogado: tenta o padrão da temporada mesmo assim.
  const candidates = exact.length
    ? exact
    : item.players.filter((player) => Number(player.season || 1) === season);
  const players = candidates.length ? candidates : item.players;

  return players.slice(0, 5).map((player, index) => ({
    name: "NoveFlix",
    title: index === 0 ? `${item.name} — T${season} E${episode}` : `${item.name} — Fonte ${index + 1}`,
    url: player.kind === "single" ? player.mediaUrl : episodeUrl(player, episode),
    behaviorHints: { bingeGroup: `${item.id}:season:${season}` }
  }));
}

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id);
  const category = parsed && categoryByKey(parsed.category);
  if (!parsed || !category) return { streams: [] };

  try {
    const item = await getDetails(parsed.category, parsed.slug, {
      budgetMs: config.streamBudgetMs,
      deep: true
    });
    const streams = streamsFor(item, parsed).filter((stream) => Boolean(stream.url));
    console.log(`Stream ${id}: ${streams.length} fonte(s)`);
    return {
      streams,
      cacheMaxAge: streams.length ? 30 * 60 : 60,
      staleRevalidate: 6 * 60 * 60
    };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [], cacheMaxAge: 60 };
  }
});

/* --------------------------------------------------------------------------
 * Servidor HTTP: rotas do addon + diagnóstico
 * ------------------------------------------------------------------------ */

function landingPage(installUrl) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NoveFlix ${VERSION}</title>
<style>
 body{background:#0b0b0f;color:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:48px 20px;text-align:center}
 h1{font-size:2rem;margin:0 0 8px} p{color:#a1a1aa;margin:4px 0}
 code{background:#18181b;padding:4px 8px;border-radius:6px;display:inline-block;margin-top:16px;word-break:break-all}
 a.button{display:inline-block;margin-top:24px;background:#7c3aed;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600}
 a{color:#a78bfa}
</style></head><body>
<h1>NoveFlix</h1>
<p>Addon Stremio ${VERSION} — catálogo, metadados e players.</p>
<a class="button" href="stremio://${installUrl.replace(/^https?:\/\//, "")}">Instalar no Stremio</a>
<p><code>${installUrl}</code></p>
<p style="margin-top:32px"><a href="/health">/health</a> · <a href="/diag/catalog/novelas">/diag/catalog/novelas</a></p>
</body></html>`;
}

function healthPayload() {
  return {
    ok: true,
    version: VERSION,
    site: config.siteBase,
    cdn: config.cdnHost,
    browserEnabled: config.enableBrowser,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    startedAt: status.startedAt,
    lastError: status.lastError,
    categories: config.categories.map((category) => ({
      key: category.key,
      ...(status.categories[category.key] || { items: 0, source: null, updatedAt: null, lastError: null })
    }))
  };
}

function start() {
  const app = express();

  app.get("/health", (_req, res) => res.json(healthPayload()));

  app.get("/diag/catalog/:key", async (req, res) => {
    const category = categoryByKey(req.params.key);
    if (!category) return res.status(404).json({ error: "categoria desconhecida" });
    try {
      const items = await getCategoryItems(category, config.catalogBudgetMs);
      res.json({
        category: category.key,
        total: items.length,
        state: status.categories[category.key] || null,
        sample: items.slice(0, 10).map((item) => ({ id: item.id, name: item.name, pageUrl: item.pageUrl, poster: item.poster }))
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/diag/meta/:id", async (req, res) => {
    const parsed = parseId(req.params.id);
    const category = parsed && categoryByKey(parsed.category);
    if (!category) return res.status(400).json({ error: "id inválido" });
    try {
      const item = await getDetails(parsed.category, parsed.slug, {
        budgetMs: config.streamBudgetMs,
        deep: req.query.deep !== "0"
      });
      res.json({ item: { ...item, players: item.players || [] } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/diag/cache", (_req, res) => {
    res.json({
      catalog: caches.catalogCache.keys(),
      details: caches.detailCache.keys(),
      pageUrls: caches.pageUrlCache.keys().length
    });
  });

  app.use(getRouter(builder.getInterface()));

  app.get("/", (req, res) => {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(landingPage(`${proto}://${host}/manifest.json`));
  });

  const server = app.listen(config.port, () => {
    console.log(`NoveFlix ${VERSION} em http://127.0.0.1:${config.port}/manifest.json`);
    console.log(`Site: ${config.siteBase} | navegador: ${config.enableBrowser ? "ativo" : "desligado"}`);
    warmup();
  });

  return server;
}

process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection:", error?.stack || error?.message || error);
});
process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error?.stack || error?.message || error);
});

if (require.main === module) start();

module.exports = { start, manifest, builder, parseId, toMeta, buildVideos, streamsFor, healthPayload };
