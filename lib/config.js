"use strict";

const categories = [
  { key: "novelas", name: "NoveFlix — Novelas", type: "series", genre: "Novela", episodic: true },
  { key: "series", name: "NoveFlix — Séries", type: "series", genre: "Série", episodic: true },
  { key: "programas", name: "NoveFlix — Programas", type: "series", genre: "Programa", episodic: true },
  { key: "shows", name: "NoveFlix — Shows", type: "series", genre: "Show", episodic: true },
  { key: "filmes", name: "NoveFlix — Filmes", type: "movie", genre: "Filme", episodic: false }
];

module.exports = {
  port: Number(process.env.PORT || 10000),
  bridgeUrl: String(
    process.env.NOVEFLIX_BRIDGE_URL ||
    "https://noveflixtv.com/wp-json/noveflix-stremio/v1"
  ).replace(/\/$/, ""),
  bridgeToken: String(process.env.NOVEFLIX_BRIDGE_TOKEN || ""),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 20000),
  cacheMs: Number(process.env.CACHE_MINUTES || 20) * 60_000,
  pageSize: 50,
  maxEpisodes: Number(process.env.MAX_EPISODES || 3000),
  cdnOrigin: process.env.NOVEFLIX_CDN_ORIGIN || "https://23rzv4udpdbv8t6.cdn-novflix.com",
  defaultPoster: process.env.NOVEFLIX_DEFAULT_POSTER || "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
  defaultBackground: process.env.NOVEFLIX_DEFAULT_BACKGROUND || "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
  userAgent: "Mozilla/5.0 (compatible; NoveFlix-Stremio/4.0; +https://noveflix.co)",
  categories
};
