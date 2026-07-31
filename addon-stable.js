"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const config = require("./config");

const catalogCache = new Map();
const detailCache = new Map();

const clean = (v = "") => String(v).replace(/\s+/g, " ").trim();
const pad = (n) => String(n).padStart(3, "0");

function abs(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}

function isContentUrl(value) {
  try { return /\/(?:assista|assistir)(?:\/|$)/i.test(new URL(value).pathname); }
  catch { return false; }
}

function slugFromUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const marker = Math.max(parts.indexOf("assista"), parts.indexOf("assistir"));
    return decodeURIComponent((marker >= 0 ? parts.slice(marker + 1).at(-1) : parts.at(-1)) || "").toLowerCase();
  } catch { return ""; }
}

function contentId(category, slug) { return `noveflix:${category}:${slug}`; }
function episodeId(item, episode) { return `${item.id}:1:${episode}`; }

function parseId(id) {
  const parts = String(id).split(":");
  if (parts[0] !== "noveflix" || parts.length < 3) return null;
  return {
    category: parts[1],
    slug: parts[2],
    season: Number(parts[3]),
    episode: Number(parts[4])
  };
}

function categoryByKey(key) {
  return config.categories.find((item) => item.key === key) || null;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeout || config.requestTimeoutMs),
    headers: {
      "user-agent": config.userAgent,
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return { text: await response.text(), finalUrl: response.url };
}

function metaValue($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = node.attr("content") || node.attr("href") || node.attr("src");
    if (value) return clean(value);
  }
  return null;
}

function cardTitle($, anchor, slug) {
  const node = $(anchor);
  const img = node.find("img").first();
  return clean(
    img.attr("alt") || img.attr("title") || node.attr("title") ||
    node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() ||
    node.text() || slug.replace(/-/g, " ")
  );
}

function cardImage($, anchor, base) {
  const img = $(anchor).find("img").first();
  return abs(img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("src"), base);
}

async function scrapeCategory(category, force = false) {
  const cached = catalogCache.get(category.key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const found = new Map();
  for (let page = 1; page <= config.maxCatalogPages; page += 1) {
    const url = page === 1 ? category.url : `${category.url.replace(/\/$/, "")}/page/${page}/`;
    let response;
    try { response = await fetchText(url); }
    catch (error) {
      if (page === 1) console.error(`Catálogo ${category.key}: ${error.message}`);
      break;
    }

    const $ = cheerio.load(response.text);
    let added = 0;
    $('a[href]').each((_, anchor) => {
      const pageUrl = abs($(anchor).attr("href"), response.finalUrl);
      if (!pageUrl || !isContentUrl(pageUrl)) return;
      const slug = slugFromUrl(pageUrl);
      if (!slug || config.ignoredSlugs.includes(slug)) return;

      const previous = found.get(slug);
      const name = cardTitle($, anchor, slug);
      const image = cardImage($, anchor, response.finalUrl);
      found.set(slug, {
        id: contentId(category.key, slug),
        category: category.key,
        slug,
        pageUrl,
        type: category.type,
        episodic: category.episodic,
        name: previous?.name && previous.name.length > name.length ? previous.name : name,
        poster: previous?.poster || image,
        background: previous?.background || image,
        description: previous?.description || `Assista ${name} no NoveFlix.`,
        genres: [category.genre]
      });
      if (!previous) added += 1;
    });
    if (added === 0) break;
  }

  for (const fallback of config.fallbackShows.filter((item) => item.category === category.key)) {
    if (!found.has(fallback.slug)) {
      found.set(fallback.slug, {
        ...fallback,
        id: contentId(category.key, fallback.slug),
        genres: [fallback.genre || category.genre]
      });
    }
  }

  const value = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  catalogCache.set(category.key, { value, expiresAt: Date.now() + config.catalogCacheMinutes * 60000 });
  console.log(`${category.name}: ${value.length} itens.`);
  return value;
}

function extractUrls(html, base) {
  const urls = new Set();
  const $ = cheerio.load(html);
  $('[href],[src],[data-src],[data-url]').each((_, el) => {
    for (const attr of ["href", "src", "data-src", "data-url"]) {
      const url = abs($(el).attr(attr), base);
      if (url) urls.add(url);
    }
  });
  for (const match of html.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || []) {
    urls.add(match.replace(/\\\//g, "/").replace(/&amp;/g, "&"));
  }
  return [...urls];
}

function directMedia(html, base) {
  const patterns = [
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const url = abs(match[1].replace(/\\\//g, "/").replace(/&amp;/g, "&"), base);
      if (url) return url;
    }
  }
  return null;
}

async function resolveMedia(url, depth = 0) {
  if (!url || depth > 3) return null;
  if (/\.(mp4|m3u8)(\?|$)/i.test(url)) return url;
  try {
    const page = await fetchText(url);
    const direct = directMedia(page.text, page.finalUrl);
    if (direct) return direct;
    const nested = extractUrls(page.text, page.finalUrl).find((item) =>
      /novefx\.biz\/v\//i.test(item) || /\.(mp4|m3u8)(\?|$)/i.test(item)
    );
    return nested ? resolveMedia(nested, depth + 1) : null;
  } catch { return null; }
}

function mediaPattern(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(.*\/)([^/]+)-(\d+)\.(mp4|m3u8)$/i);
    if (!match) return null;
    return {
      basePath: `${parsed.origin}${match[1]}`,
      code: match[2],
      currentEpisode: Number(match[3]),
      extension: match[4].toLowerCase()
    };
  } catch { return null; }
}

function episodeUrl(pattern, episode) {
  return `${pattern.basePath}${pattern.code}-${pad(episode)}.${pattern.extension}`;
}

async function urlExists(url) {
  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(config.mediaCheckTimeoutMs),
      headers: { "user-agent": config.userAgent }
    });
    if (response.ok) return true;
    if ([403, 405, 501].includes(response.status)) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(config.mediaCheckTimeoutMs),
        headers: { "user-agent": config.userAgent, Range: "bytes=0-0" }
      });
      return response.ok || response.status === 206;
    }
  } catch {}
  return false;
}

async function latestEpisode(pattern) {
  let latest = Math.max(1, pattern.currentEpisode || 1);
  for (let candidate = latest + 1; candidate <= latest + config.maxFutureEpisodeChecks; candidate += 1) {
    if (!(await urlExists(episodeUrl(pattern, candidate)))) break;
    latest = candidate;
  }
  return latest;
}

async function details(categoryKey, slug, force = false) {
  const cacheKey = `${categoryKey}:${slug}`;
  const cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const category = categoryByKey(categoryKey);
  if (!category) throw new Error(`Categoria inválida: ${categoryKey}`);
  const catalog = await scrapeCategory(category);
  const base = catalog.find((item) => item.slug === slug);
  if (!base) throw new Error(`Conteúdo não encontrado: ${cacheKey}`);

  let value = { ...base, mediaUrl: null, pattern: null, latestEpisode: null };
  try {
    const page = await fetchText(base.pageUrl);
    const $ = cheerio.load(page.text);
    const name = clean(metaValue($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) || $('h1').first().text() || base.name)
      .replace(/\s*[|–-]\s*NoveFlix.*$/i, "");
    const description = clean(metaValue($, ['meta[property="og:description"]', 'meta[name="description"]']) || $('.sinopse,.synopsis,.description,.entry-content p').first().text() || base.description);
    const poster = abs(metaValue($, ['meta[property="og:image"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) || base.poster, page.finalUrl);
    const background = abs(metaValue($, ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]']) || poster, page.finalUrl);
    const year = clean(page.text).match(/(?:19|20)\d{2}/)?.[0];

    value = { ...value, name, description, poster, background, releaseInfo: year };

    let mediaUrl = directMedia(page.text, page.finalUrl);
    if (!mediaUrl) {
      const candidates = extractUrls(page.text, page.finalUrl).filter((item) =>
        /novefx\.biz\/v\//i.test(item) || /esportesdavez\.com/i.test(item) || /\.(mp4|m3u8)(\?|$)/i.test(item)
      );
      for (const candidate of candidates.slice(0, config.maxPlayerCandidates)) {
        mediaUrl = await resolveMedia(candidate);
        if (mediaUrl) break;
      }
    }

    if (mediaUrl) {
      value.mediaUrl = mediaUrl;
      value.pattern = category.episodic ? mediaPattern(mediaUrl) : null;
      value.latestEpisode = value.pattern ? await latestEpisode(value.pattern) : null;
    } else {
      console.warn(`Player ainda não localizado para ${value.name}; metadados serão exibidos mesmo assim.`);
    }
  } catch (error) {
    console.warn(`Detalhes parciais para ${base.name}: ${error.message}`);
  }

  detailCache.set(cacheKey, { value, expiresAt: Date.now() + config.showCacheMinutes * 60000 });
  return value;
}

function toMeta(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster || config.defaultPoster,
    posterShape: "poster",
    background: item.background || item.poster || config.defaultBackground,
    description: item.description || `Assista ${item.name} no NoveFlix.`,
    genres: item.genres || [],
    releaseInfo: item.releaseInfo
  };
}

function videos(item) {
  if (!item.episodic || !item.pattern || !item.latestEpisode) return [];
  return Array.from({ length: item.latestEpisode }, (_, i) => {
    const episode = i + 1;
    return { id: episodeId(item, episode), title: `Episódio ${episode}`, season: 1, episode };
  });
}

const manifest = {
  id: "com.noveflix.catalog",
  version: "3.0.2",
  name: "NoveFlix",
  description: "Catálogo automático do NoveFlix",
  logo: config.defaultPoster,
  background: config.defaultBackground,
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
  const category = config.categories.find((item) => `noveflix-${item.key}` === id && item.type === type);
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
  const parsed = parseId(id);
  if (!parsed) return { meta: null };
  const category = categoryByKey(parsed.category);
  if (!category || category.type !== type) return { meta: null };
  try {
    const item = await details(parsed.category, parsed.slug);
    const meta = toMeta(item);
    if (item.episodic) meta.videos = videos(item);
    console.log(`Meta entregue: ${id} (${meta.videos?.length || 0} episódios)`);
    return { meta };
  } catch (error) {
    console.error(`Meta ${id}: ${error.stack || error.message}`);
    const catalog = await scrapeCategory(category).catch(() => []);
    const fallback = catalog.find((item) => item.slug === parsed.slug);
    return fallback ? { meta: toMeta(fallback) } : { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  const parsed = parseId(id);
  if (!parsed) return { streams: [] };
  const category = categoryByKey(parsed.category);
  if (!category || category.type !== type) return { streams: [] };
  try {
    const item = await details(parsed.category, parsed.slug);
    if (!item.episodic) {
      return item.mediaUrl ? { streams: [{ name: "NoveFlix", title: item.name, url: item.mediaUrl }] } : { streams: [] };
    }
    if (!item.pattern || !Number.isInteger(parsed.episode) || parsed.episode < 1 || parsed.episode > item.latestEpisode) return { streams: [] };
    return { streams: [{
      name: "NoveFlix",
      title: `${item.name} — Episódio ${parsed.episode}`,
      url: episodeUrl(item.pattern, parsed.episode),
      behaviorHints: { bingeGroup: `${item.id}:season:1` }
    }] };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 3.0.2 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
