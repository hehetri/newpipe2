"use strict";

const config = require("./config");
const { getJson } = require("./http");
const { TTLCache } = require("./cache");

const cache = new TTLCache(config.cacheMs);

function headers() {
  return config.bridgeToken ? { "x-noveflix-token": config.bridgeToken } : {};
}

function url(path, params = {}) {
  const target = new URL(`${config.bridgeUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }
  return target.href;
}

async function health() {
  return getJson(url("/health"), { headers: headers() });
}

async function catalog(category, page, perPage, search = "") {
  const cacheKey = `catalog:${category}:${page}:${perPage}:${search}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await getJson(url("/catalog", {
    category,
    page,
    per_page: perPage,
    search
  }), { headers: headers() });

  return cache.set(cacheKey, data);
}

async function item(id, category) {
  const cacheKey = `item:${category}:${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await getJson(url(`/item/${encodeURIComponent(id)}`, { category }), {
    headers: headers()
  });

  return cache.set(cacheKey, data);
}

module.exports = { health, catalog, item };
