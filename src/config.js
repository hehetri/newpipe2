"use strict";

module.exports = {
  port: Number(process.env.PORT || 10000),
  siteBase: process.env.NOVEFLIX_SITE || "https://noveflix.co",
  cdnHost: process.env.NOVEFLIX_CDN || "https://23rzv4udpdbv8t6.cdn-novflix.com",
  requestTimeoutMs: 20000,
  browserTimeoutMs: 30000,
  mediaCheckTimeoutMs: 8000,
  pageSize: 50,
  maxCatalogPages: 40,
  catalogCacheMs: 30 * 60 * 1000,
  detailCacheMs: 60 * 60 * 1000,
  resolverCacheMs: 6 * 60 * 60 * 1000,
  maxFutureEpisodeChecks: 15,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  defaultPoster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
  categories: [
    { key: "novelas", name: "NoveFlix — Novelas", path: "/categoria/novelas/", type: "series", genre: "Novela", episodic: true },
    { key: "series", name: "NoveFlix — Séries", path: "/categoria/series/", type: "series", genre: "Série", episodic: true },
    { key: "programas", name: "NoveFlix — Programas", path: "/categoria/programas/", type: "series", genre: "Programa", episodic: true },
    { key: "shows", name: "NoveFlix — Shows", path: "/categoria/shows/", type: "series", genre: "Show", episodic: true },
    { key: "filmes", name: "NoveFlix — Filmes", path: "/categoria/filmes/", type: "movie", genre: "Filme", episodic: false }
  ],
  knownPlayers: {
    "novelas-a-escrava-isaura": { panelUrl: "https://painel6.novefx.biz/v/ESC167" },
    "novelas-quem-ama-cuida": { panelUrl: "https://painel1.novefx.biz/v/QAC063" }
  }
};
