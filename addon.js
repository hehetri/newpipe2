"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const config = require("./config");

const catalogCache = new Map();
const detailCache = new Map();

const normalize = (value = "") => String(value).replace(/\s+/g, " ").trim();
const pad = (value) => String(value).padStart(3, "0");

function absoluteUrl(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}

function slugFromUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const index = parts.indexOf("assista");
    return decodeURIComponent(parts[index >= 0 ? index + 1 : parts.length - 1] || "").toLowerCase();
  } catch { return ""; }
}

function contentId(category, slug) {
  return `noveflix:${category}:${slug}`;
}

function episodeId(item, episode) {
  return `${item.id}:1:${episode}`;
}

function parseContentId(id) {
  const parts = String(id).split(":");
  if (parts[0] !== "noveflix" || parts.length < 3) return null;
  return { category: parts[1], slug: parts[2], season: Number(parts[3]), episode: Number(parts[4]) };
}

function getCategory(key) {
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

function metaContent($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = node.attr("content") || node.attr("href") || node.attr("src");
    if (value) return normalize(value);
  }
  return null;
}

function cardTitle($, anchor) {
  const node = $(anchor);
  const image = node.find("img").first();
  return normalize(
    image.attr("alt") || image.attr("title") || node.attr("title") ||
    node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() ||
    node.text()
  );
}

function cardImage($, anchor, baseUrl) {
  const image = $(anchor).find("img").first();
  return absoluteUrl(
    image.attr("data-src") || image.attr("data-lazy-src") ||
    image.attr("data-original") || image.attr("src"),
    baseUrl
  );
}

async function scrapeCategory(category, force = false) {
  const cached = catalogCache.get(category.key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const found = new Map();
  for (let page = 1; page <= config.maxCatalogPages; page += 1) {
    const pageUrl = page === 1 ? category.url : `${category.url.replace(/\/$/, "")}/page/${page}/`;
    let parsed;
    try { parsed = await fetchText(pageUrl); }
    catch (error) {
      if (page === 1) console.error(`Catálogo ${category.key}: ${error.message}`);
      break;
    }

    const $ = cheerio.load(parsed.text);
    let added = 0;
    $('a[href]').each((_, anchor) => {
      const href = absoluteUrl($(anchor).attr("href"), parsed.finalUrl);
      if (!href || !/\/assista\//i.test(href)) return;
      const slug = slugFromUrl(href);
      if (!slug || config.ignoredSlugs.includes(slug)) return;

      const title = cardTitle($, anchor) || slug.replace(/-/g, " ");
      if (title.length < 2) return;
      const previous = found.get(slug);
      found.set(slug, {
        id: contentId(category.key, slug),
        category: category.key,
        slug,
        pageUrl: href,
        type: category.type,
        episodic: category.episodic,
        name: previous?.name && previous.name.length > title.length ? previous.name : title,
        poster: previous?.poster || cardImage($, anchor, parsed.finalUrl),
        background: previous?.background || cardImage($, anchor, parsed.finalUrl),
        description: previous?.description || `Assista ${title} no NoveFlix.`,
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
        category: category.key,
        genres: [fallback.genre || category.genre]
      });
    }
  }

  const value = [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  catalogCache.set(category.key, {
    value,
    expiresAt: Date.now() + config.catalogCacheMinutes * 60_000
  });
  console.log(`${category.name}: ${value.length} itens.`);
  return value;
}

function extractJsonLd($) {
  const values = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const data = JSON.parse($(element).html());
      if (Array.isArray(data)) values.push(...data);
      else if (Array.isArray(data?.["@graph"])) values.push(...data["@graph"]);
      else values.push(data);
    } catch {}
  });
  return values;
}

function decodeRedirect(raw) {
  try {
    const url = new URL(raw);
    for (const [key, value] of url.searchParams) {
      if (!key.toLowerCase().includes("safelink")) continue;
      try {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        const json = JSON.parse(decoded);
        return json.safelink || json.second_safelink_url || raw;
      } catch {}
    }
  } catch {}
  return raw;
}

function extractUrls(html, baseUrl) {
  const urls = new Set();
  const $ = cheerio.load(html);
  $('[href],[src],[data-src],[data-url]').each((_, element) => {
    for (const attr of ["href", "src", "data-src", "data-url"]) {
      const url = absoluteUrl($(element).attr(attr), baseUrl);
      if (url) urls.add(decodeRedirect(url));
    }
  });
  for (const match of html.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || []) {
    urls.add(match.replace(/\\\//g, "/").replace(/&amp;/g, "&"));
  }
  return [...urls];
}

function directMedia(html, baseUrl) {
  const patterns = [
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) {
      const url = absoluteUrl(match[1].replace(/\\\//g, "/").replace(/&amp;/g, "&"), baseUrl);
      if (url) return url;
    }
  }
  return null;
}

async function resolveMedia(url, depth = 0) {
  if (!url || depth > 3) return null;
  const decoded = decodeRedirect(url);
  if (/\.(mp4|m3u8)(\?|$)/i.test(decoded)) return decoded;

  try {
    const page = await fetchText(decoded);
    const direct = directMedia(page.text, page.finalUrl);
    if (direct) return direct;
    const nested = extractUrls(page.text, page.finalUrl).find((candidate) =>
      /novefx\.biz\/v\//i.test(candidate) || /\.(mp4|m3u8)(\?|$)/i.test(candidate)
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

function buildEpisodeUrl(pattern, episode) {
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

async function discoverLatest(pattern) {
  let latest = Math.max(1, pattern.currentEpisode || 1);
  for (let candidate = latest + 1; candidate <= latest + config.maxFutureEpisodeChecks; candidate += 1) {
    if (!(await urlExists(buildEpisodeUrl(pattern, candidate)))) break;
    latest = candidate;
  }
  return latest;
}

async function loadDetails(categoryKey, slug, force = false) {
  const cacheKey = `${categoryKey}:${slug}`;
  const cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const category = getCategory(categoryKey);
  if (!category) throw new Error(`Categoria inválida: ${categoryKey}`);
  const catalog = await scrapeCategory(category);
  const base = catalog.find((item) => item.slug === slug);
  if (!base) throw new Error(`Conteúdo não encontrado: ${cacheKey}`);

  const page = await fetchText(base.pageUrl);
  const $ = cheerio.load(page.text);
  const jsonLd = extractJsonLd($);

  const name = normalize(
    metaContent($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('h1').first().text() || jsonLd.find((item) => item?.name)?.name || base.name
  ).replace(/\s*[|–-]\s*NoveFlix.*$/i, "");

  const description = normalize(
    metaContent($, ['meta[property="og:description"]', 'meta[name="description"]']) ||
    jsonLd.find((item) => item?.description)?.description ||
    $('.sinopse,.synopsis,.description,.entry-content p').first().text() || base.description
  );

  const poster = absoluteUrl(
    metaContent($, ['meta[property="og:image"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) ||
    jsonLd.find((item) => item?.image)?.image || base.poster,
    page.finalUrl
  );

  const background = absoluteUrl(
    metaContent($, ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]']) || poster,
    page.finalUrl
  );

  let mediaUrl = directMedia(page.text, page.finalUrl);
  if (!mediaUrl) {
    const candidates = extractUrls(page.text, page.finalUrl).filter((url) =>
      /novefx\.biz\/v\//i.test(url) || /esportesdavez\.com/i.test(url) || /\.(mp4|m3u8)(\?|$)/i.test(url)
    );
    for (const candidate of candidates.slice(0, config.maxPlayerCandidates)) {
      mediaUrl = await resolveMedia(candidate);
      if (mediaUrl) break;
    }
  }

  if (!mediaUrl) throw new Error(`Player não localizado: ${name}`);
  const pattern = category.episodic ? mediaPattern(mediaUrl) : null;
  const latestEpisode = pattern ? await discoverLatest(pattern) : null;
  const year = normalize(page.text).match(/(?:19|20)\d{2}/)?.[0];

  const value = {
    ...base,
    name,
    description,
    poster,
    background,
    releaseInfo: year,
    mediaUrl,
    pattern,
    latestEpisode
  };

  detailCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + config.showCacheMinutes * 60_000
  });
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

function buildVideos(item) {
  if (!item.episodic || !item.pattern || !item.latestEpisode) return [];
  return Array.from({ length: item.latestEpisode }, (_, index) => {
    const episode = index + 1;
    return { id: episodeId(item, episode), title: `Episódio ${episode}`, season: 1, episode };
  });
}

const manifest = {
  id: "com.noveflix.catalog",
  version: "3.0.0",
  name: "NoveFlix",
  description: "Catálogo automático do NoveFlix",
  logo: config.defaultPoster,
  background: config.defaultBackground,
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["noveflix:"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
    newEpisodeNotifications: true
  },
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
    const search = normalize(extra.search).toLocaleLowerCase("pt-BR");
    if (search) items = items.filter((item) => item.name.toLocaleLowerCase("pt-BR").includes(search));
    const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
    return { metas: items.slice(skip, skip + config.pageSize).map(toMeta) };
  } catch (error) {
    console.error(`Catalog ${category.key}: ${error.stack || error.message}`);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  const parsed = parseContentId(id);
  if (!parsed) return { meta: null };
  const category = getCategory(parsed.category);
  if (!category || category.type !== type) return { meta: null };

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
  const parsed = parseContentId(id);
  if (!parsed) return { streams: [] };
  const category = getCategory(parsed.category);
  if (!category || category.type !== type) return { streams: [] };

  try {
    const item = await loadDetails(parsed.category, parsed.slug);
    if (!item.episodic) {
      return {
        streams: [{ name: "NoveFlix", title: item.name, url: item.mediaUrl }]
      };
    }

    if (!Number.isInteger(parsed.episode) || parsed.episode < 1 || parsed.episode > item.latestEpisode) {
      return { streams: [] };
    }

    return {
      streams: [{
        name: "NoveFlix",
        title: `${item.name} — Episódio ${parsed.episode}`,
        url: buildEpisodeUrl(item.pattern, parsed.episode),
        behaviorHints: { bingeGroup: `${item.id}:season:1` }
      }]
    };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 3.0 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
