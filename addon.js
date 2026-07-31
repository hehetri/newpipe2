"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const config = require("./config");

const catalogCache = { value: null, expiresAt: 0 };
const showCache = new Map();

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function absoluteUrl(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}

function slugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const assista = parts.indexOf("assista");
    return decodeURIComponent(parts[assista >= 0 ? assista + 1 : parts.length - 1] || "").toLowerCase();
  } catch { return ""; }
}

function showId(slug) { return `noveflix:${slug}`; }
function videoId(slug, episode) { return `${showId(slug)}:1:${episode}`; }
function padEpisode(number) { return String(number).padStart(3, "0"); }

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeout || config.requestTimeoutMs),
    headers: {
      "user-agent": config.userAgent,
      "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
  return { text: await response.text(), url: response.url, headers: response.headers };
}

function firstMeta($, selectors) {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content") || $(selector).first().attr("href") || $(selector).first().attr("src");
    if (value) return normalizeText(value);
  }
  return null;
}

function titleFromCard($, anchor) {
  const node = $(anchor);
  const image = node.find("img").first();
  return normalizeText(
    image.attr("alt") || image.attr("title") || node.attr("title") ||
    node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() ||
    node.text()
  );
}

function imageFromCard($, anchor) {
  const image = $(anchor).find("img").first();
  return absoluteUrl(
    image.attr("data-src") || image.attr("data-lazy-src") || image.attr("data-original") || image.attr("src")
  );
}

function parseJsonLd($) {
  const records = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html());
      const values = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
      records.push(...values);
    } catch {}
  });
  return records;
}

async function loadCatalog(force = false) {
  if (!force && catalogCache.value && Date.now() < catalogCache.expiresAt) return catalogCache.value;

  const unique = new Map();
  for (const catalogUrl of config.catalogUrls) {
    try {
      const { text, url: finalUrl } = await fetchText(catalogUrl);
      const $ = cheerio.load(text);

      $('a[href]').each((_, anchor) => {
        const href = absoluteUrl($(anchor).attr('href'), finalUrl);
        if (!href || !/\/assista\//i.test(href)) return;
        const slug = slugFromUrl(href);
        if (!slug || config.ignoredSlugs.includes(slug)) return;

        const name = titleFromCard($, anchor) || slug.replace(/-/g, " ");
        const poster = imageFromCard($, anchor);
        const previous = unique.get(slug) || {};
        unique.set(slug, {
          slug,
          id: showId(slug),
          type: "series",
          name: previous.name && previous.name.length > name.length ? previous.name : name,
          poster: previous.poster || poster,
          posterShape: "poster",
          pageUrl: href,
          genres: ["Novela"]
        });
      });
    } catch (error) {
      console.error(`Falha ao ler catálogo ${catalogUrl}: ${error.message}`);
    }
  }

  if (!unique.size && config.fallbackShows.length) {
    for (const item of config.fallbackShows) unique.set(item.slug, { ...item, id: showId(item.slug), type: "series", posterShape: "poster" });
  }

  const catalog = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  catalogCache.value = catalog;
  catalogCache.expiresAt = Date.now() + config.catalogCacheMinutes * 60_000;
  console.log(`Catálogo atualizado: ${catalog.length} novelas.`);
  return catalog;
}

function decodePotentialSafelink(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of url.searchParams) {
      if (key.toLowerCase().includes("safelink_redirect")) {
        try {
          const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
          return parsed.safelink || parsed.second_safelink_url || rawUrl;
        } catch {}
      }
    }
    const rawQuery = url.search.slice(1);
    if (rawQuery && !rawQuery.includes("=")) {
      try {
        const decoded = Buffer.from(rawQuery, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {}
    }
  } catch {}
  return rawUrl;
}

function extractUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const $ = cheerio.load(html);
  $('[href],[src],[data-src],[data-url]').each((_, el) => {
    for (const attr of ["href", "src", "data-src", "data-url"]) {
      const value = $(el).attr(attr);
      const absolute = absoluteUrl(value, baseUrl);
      if (absolute) urls.add(decodePotentialSafelink(absolute));
    }
  });
  const regex = /https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
  for (const match of html.match(regex) || []) urls.add(match.replace(/\\\//g, "/").replace(/&amp;/g, "&"));
  return [...urls];
}

function mediaPatternFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(.*\/)([^/]+)-(\d+)\.(mp4|m3u8)$/i);
    if (!match) return null;
    return {
      basePath: `${parsed.origin}${match[1]}`,
      code: match[2],
      currentEpisode: Number(match[3]),
      extension: match[4].toLowerCase(),
      sampleUrl: url
    };
  } catch { return null; }
}

function extractDirectMedia(html) {
  const candidates = [];
  const patterns = [
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html))) candidates.push(match[1].replace(/\\\//g, "/").replace(/&amp;/g, "&"));
  }
  return [...new Set(candidates)];
}

async function resolvePlayerPage(url) {
  const decoded = decodePotentialSafelink(url);
  if (/\.(mp4|m3u8)(\?|$)/i.test(decoded)) return decoded;
  try {
    const { text, url: finalUrl } = await fetchText(decoded);
    const direct = extractDirectMedia(text)[0];
    if (direct) return absoluteUrl(direct, finalUrl);

    const nested = extractUrlsFromHtml(text, finalUrl).find((candidate) =>
      candidate !== decoded && (/novefx\.biz\/v\//i.test(candidate) || /\.(mp4|m3u8)(\?|$)/i.test(candidate))
    );
    if (nested) return resolvePlayerPage(nested);
  } catch (error) {
    console.warn(`Falha ao resolver player ${url}: ${error.message}`);
  }
  return null;
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

function episodeUrl(pattern, episode) {
  return `${pattern.basePath}${pattern.code}-${padEpisode(episode)}.${pattern.extension}`;
}

async function discoverLatest(pattern) {
  let latest = Math.max(1, pattern.currentEpisode || 1);
  for (let episode = latest + 1; episode <= latest + config.maxFutureEpisodeChecks; episode += 1) {
    if (!(await urlExists(episodeUrl(pattern, episode)))) break;
    latest = episode;
  }
  return latest;
}

async function loadShow(slug, force = false) {
  const cached = showCache.get(slug);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;

  const catalog = await loadCatalog();
  const base = catalog.find((item) => item.slug === slug) || config.fallbackShows.find((item) => item.slug === slug);
  if (!base) throw new Error(`Novela não encontrada: ${slug}`);

  const pageUrl = base.pageUrl || `${config.siteBase}/assista/${slug}/`;
  const { text, url: finalUrl } = await fetchText(pageUrl);
  const $ = cheerio.load(text);
  const jsonLd = parseJsonLd($);

  const title = normalizeText(
    firstMeta($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('h1').first().text() || jsonLd.find((x) => x.name)?.name || base.name
  ).replace(/\s*[|–-]\s*NoveFlix.*$/i, "");

  const description = normalizeText(
    firstMeta($, ['meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]']) ||
    jsonLd.find((x) => x.description)?.description ||
    $('.sinopse,.synopsis,.description,.entry-content p').first().text() ||
    `Episódios de ${title} no NoveFlix.`
  );

  const poster = absoluteUrl(
    firstMeta($, ['meta[property="og:image"]', 'meta[name="twitter:image"]', 'link[rel="image_src"]']) ||
    jsonLd.find((x) => x.image)?.image || base.poster,
    finalUrl
  );

  const background = absoluteUrl(
    firstMeta($, ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]']) || poster,
    finalUrl
  );

  const pageUrls = extractUrlsFromHtml(text, finalUrl);
  const playerCandidates = pageUrls.filter((url) =>
    /novefx\.biz\/v\//i.test(url) || /esportesdavez\.com/i.test(url) || /\.(mp4|m3u8)(\?|$)/i.test(url)
  );

  let mediaUrl = extractDirectMedia(text)[0] || null;
  if (!mediaUrl) {
    for (const candidate of playerCandidates.slice(0, config.maxPlayerCandidates)) {
      mediaUrl = await resolvePlayerPage(candidate);
      if (mediaUrl) break;
    }
  }

  const pattern = mediaUrl ? mediaPatternFromUrl(mediaUrl) : null;
  if (!pattern) throw new Error(`Não foi possível identificar o padrão dos episódios de ${title}.`);

  const latestEpisode = await discoverLatest(pattern);
  const year = String(firstMeta($, ['meta[property="video:release_date"]']) || new Date().getFullYear()).match(/\d{4}/)?.[0];

  const value = {
    slug,
    id: showId(slug),
    type: "series",
    name: title,
    description,
    poster,
    background,
    genres: ["Novela"],
    releaseInfo: year,
    pattern,
    latestEpisode,
    firstEpisode: 1
  };
  showCache.set(slug, { value, expiresAt: Date.now() + config.showCacheMinutes * 60_000 });
  return value;
}

function buildVideos(show) {
  const videos = [];
  for (let episode = show.firstEpisode; episode <= show.latestEpisode; episode += 1) {
    videos.push({ id: videoId(show.slug, episode), title: `Episódio ${episode}`, season: 1, episode });
  }
  return videos;
}

function catalogMeta(item) {
  return {
    id: item.id,
    type: "series",
    name: item.name,
    poster: item.poster || config.defaultPoster,
    posterShape: "poster",
    background: item.background || item.poster || config.defaultBackground,
    description: item.description || `Assista ${item.name} no NoveFlix.`,
    genres: item.genres || ["Novela"],
    releaseInfo: item.releaseInfo
  };
}

const manifest = {
  id: "com.noveflix.catalog",
  version: "2.0.0",
  name: "NoveFlix",
  description: "Catálogo automático de novelas do NoveFlix",
  logo: config.defaultPoster,
  background: config.defaultBackground,
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: ["noveflix:"],
  behaviorHints: { configurable: false, configurationRequired: false, newEpisodeNotifications: true },
  catalogs: [{
    type: "series",
    id: "noveflix-novelas",
    name: "NoveFlix — Novelas",
    pageSize: config.pageSize,
    extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }]
  }]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  if (type !== "series" || id !== "noveflix-novelas") return { metas: [] };
  try {
    let items = await loadCatalog();
    const search = normalizeText(extra.search).toLocaleLowerCase("pt-BR");
    if (search) items = items.filter((item) => item.name.toLocaleLowerCase("pt-BR").includes(search));
    const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
    return { metas: items.slice(skip, skip + config.pageSize).map(catalogMeta) };
  } catch (error) {
    console.error(`Catalog handler: ${error.stack || error.message}`);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series" || !id.startsWith("noveflix:")) return { meta: null };
  const slug = id.slice("noveflix:".length).split(":")[0];
  try {
    const show = await loadShow(slug);
    return { meta: { ...catalogMeta(show), videos: buildVideos(show) } };
  } catch (error) {
    console.error(`Meta ${slug}: ${error.stack || error.message}`);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series" || !id.startsWith("noveflix:")) return { streams: [] };
  const parts = id.split(":");
  const slug = parts[1];
  const episode = Number(parts.at(-1));
  if (!slug || !Number.isInteger(episode) || episode < 1) return { streams: [] };
  try {
    const show = await loadShow(slug);
    if (episode > show.latestEpisode) return { streams: [] };
    return { streams: [{
      name: "NoveFlix",
      title: `${show.name} — Episódio ${episode}`,
      url: episodeUrl(show.pattern, episode),
      behaviorHints: { bingeGroup: `${show.id}:season:1` }
    }] };
  } catch (error) {
    console.error(`Stream ${id}: ${error.stack || error.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`NoveFlix 2.0 iniciado na porta ${config.port}`);
