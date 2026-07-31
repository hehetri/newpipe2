"use strict";

module.exports = {
  port: Number(process.env.PORT || 7000),
  siteBase: "https://noveflix.co",
  requestTimeoutMs: 15000,
  mediaCheckTimeoutMs: 8000,
  userAgent: "Mozilla/5.0 (compatible; NoveFlix-Stremio/3.0; +https://noveflix.co)",

  pageSize: 50,
  maxCatalogPages: 30,
  maxPlayerCandidates: 12,
  maxFutureEpisodeChecks: 10,

  catalogCacheMinutes: 30,
  showCacheMinutes: 15,

  defaultPoster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
  defaultBackground: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",

  categories: [
    {
      key: "novelas",
      name: "NoveFlix — Novelas",
      url: "https://noveflix.co/categoria/novelas/",
      type: "series",
      genre: "Novela",
      episodic: true
    },
    {
      key: "series",
      name: "NoveFlix — Séries",
      url: "https://noveflix.co/categoria/series/",
      type: "series",
      genre: "Série",
      episodic: true
    },
    {
      key: "programas",
      name: "NoveFlix — Programas",
      url: "https://noveflix.co/categoria/programas/",
      type: "series",
      genre: "Programa",
      episodic: true
    },
    {
      key: "shows",
      name: "NoveFlix — Shows",
      url: "https://noveflix.co/categoria/shows/",
      type: "series",
      genre: "Show",
      episodic: true
    },
    {
      key: "filmes",
      name: "NoveFlix — Filmes",
      url: "https://noveflix.co/categoria/filmes/",
      type: "movie",
      genre: "Filme",
      episodic: false
    }
  ],

  ignoredSlugs: ["", "login", "cadastro", "contato"],

  fallbackShows: [
    {
      category: "novelas",
      slug: "quem-ama-cuida",
      name: "Quem Ama Cuida",
      pageUrl: "https://noveflix.co/assista/quem-ama-cuida/",
      poster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
      background: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
      description: "Episódios de Quem Ama Cuida no NoveFlix.",
      releaseInfo: "2026",
      type: "series",
      genre: "Novela",
      episodic: true
    }
  ]
};
