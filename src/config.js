"use strict";

const flag = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  return !/^(?:0|false|off|no|nao|não)$/i.test(String(value).trim());
};
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const trimSlash = (value) => String(value || "").replace(/\/+$/, "");

module.exports = {
  port: number(process.env.PORT, 10000),
  siteBase: trimSlash(process.env.NOVEFLIX_SITE || "https://noveflix.co"),
  cdnHost: trimSlash(process.env.NOVEFLIX_CDN || "https://23rzv4udpdbv8t6.cdn-novflix.com"),

  // Tempo de rede: curto o bastante para nunca estourar o timeout do Stremio/Fusion.
  requestTimeoutMs: number(process.env.NOVEFLIX_REQUEST_TIMEOUT_MS, 12000),
  requestRetries: number(process.env.NOVEFLIX_REQUEST_RETRIES, 2),
  mediaCheckTimeoutMs: number(process.env.NOVEFLIX_MEDIA_TIMEOUT_MS, 6000),
  browserTimeoutMs: number(process.env.NOVEFLIX_BROWSER_TIMEOUT_MS, 25000),

  // Orçamentos de tempo por requisição: o handler sempre responde dentro deles.
  catalogBudgetMs: number(process.env.NOVEFLIX_CATALOG_BUDGET_MS, 12000),
  catalogDeepBudgetMs: number(process.env.NOVEFLIX_CATALOG_DEEP_BUDGET_MS, 120000),
  metaBudgetMs: number(process.env.NOVEFLIX_META_BUDGET_MS, 9000),
  streamBudgetMs: number(process.env.NOVEFLIX_STREAM_BUDGET_MS, 40000),

  // Varredura do catálogo.
  pageSize: number(process.env.NOVEFLIX_PAGE_SIZE, 100),
  maxCatalogPages: number(process.env.NOVEFLIX_MAX_PAGES, 40),
  catalogPageConcurrency: number(process.env.NOVEFLIX_PAGE_CONCURRENCY, 4),

  // Caches: o valor expirado continua sendo servido enquanto atualiza em segundo plano.
  catalogCacheMs: number(process.env.NOVEFLIX_CATALOG_CACHE_MS, 30 * 60 * 1000),
  catalogStaleMs: number(process.env.NOVEFLIX_CATALOG_STALE_MS, 24 * 60 * 60 * 1000),
  detailCacheMs: number(process.env.NOVEFLIX_DETAIL_CACHE_MS, 60 * 60 * 1000),
  detailStaleMs: number(process.env.NOVEFLIX_DETAIL_STALE_MS, 24 * 60 * 60 * 1000),
  resolverCacheMs: number(process.env.NOVEFLIX_RESOLVER_CACHE_MS, 6 * 60 * 60 * 1000),
  resolverStaleMs: number(process.env.NOVEFLIX_RESOLVER_STALE_MS, 48 * 60 * 60 * 1000),

  // Descoberta de episódios novos (sondagem paralela no CDN).
  maxFutureEpisodeChecks: number(process.env.NOVEFLIX_FUTURE_EPISODES, 24),
  episodeProbeConcurrency: number(process.env.NOVEFLIX_PROBE_CONCURRENCY, 6),

  // Puppeteer entra apenas em /stream e só quando habilitado.
  enableBrowser: flag(process.env.NOVEFLIX_BROWSER, true),
  // Aquecimento do catálogo no boot, para a primeira requisição já achar cache.
  warmup: flag(process.env.NOVEFLIX_WARMUP, true),

  userAgent: process.env.NOVEFLIX_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  fallbackUserAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
  ],

  defaultPoster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",

  categories: [
    { key: "novelas", name: "NoveFlix — Novelas", path: "/categoria/novelas/", type: "series", genre: "Novela", episodic: true },
    { key: "series", name: "NoveFlix — Séries", path: "/categoria/series/", type: "series", genre: "Série", episodic: true },
    { key: "programas", name: "NoveFlix — Programas", path: "/categoria/programas/", type: "series", genre: "Programa", episodic: true },
    { key: "shows", name: "NoveFlix — Shows", path: "/categoria/shows/", type: "series", genre: "Show", episodic: true },
    { key: "filmes", name: "NoveFlix — Filmes", path: "/categoria/filmes/", type: "movie", genre: "Filme", episodic: false }
  ],

  // Caminhos testados quando o slug não está no catálogo em cache.
  contentPathPrefixes: ["assista", "assistir", "ver", "watch"],

  // Itens garantidos: o catálogo nunca volta vazio, mesmo com o site fora do ar.
  seeds: [
    {
      category: "novelas",
      slug: "quem-ama-cuida",
      name: "Quem Ama Cuida",
      poster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
      description: "Episódios de Quem Ama Cuida no NoveFlix."
    },
    {
      category: "novelas",
      slug: "a-escrava-isaura",
      name: "A Escrava Isaura",
      description: "Episódios de A Escrava Isaura no NoveFlix."
    }
  ],

  knownPlayers: {
    "novelas-a-escrava-isaura": { panelUrl: "https://painel6.novefx.biz/v/ESC167" },
    "novelas-quem-ama-cuida": { panelUrl: "https://painel1.novefx.biz/v/QAC063" }
  }
};
