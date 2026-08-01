"use strict";

const cheerio = require("cheerio");
const config = require("./config");
const { fetchText, urlExists } = require("./http");
const { TTLCache } = require("./cache");

const resolverCache = new TTLCache(config.resolverCacheMs);
let browserPromise = null;
let browserQueue = Promise.resolve();

function absoluteUrl(value, base) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}

function decodeBase64(value) {
  try {
    const normalized = decodeURIComponent(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
    const json = JSON.parse(decoded);
    return json.safelink || json.second_safelink_url || null;
  } catch { return null; }
}

function decodeSafeLink(raw) {
  try {
    const url = new URL(raw);
    const query = url.search.slice(1);
    if (query && !query.includes("=")) {
      const decoded = decodeBase64(query);
      if (decoded) return decoded;
    }
    for (const [key, value] of url.searchParams) {
      if (/safe|redirect|url|link/i.test(key)) {
        const decoded = decodeBase64(value);
        if (decoded) return decoded;
      }
    }
  } catch {}
  return raw;
}

function collectUrls(html, baseUrl) {
  const urls = new Set();
  const add = (value) => {
    if (!value) return;
    const cleaned = String(value).replace(/\\\//g, "/").replace(/&amp;/g, "&");
    const url = absoluteUrl(cleaned, baseUrl);
    if (!url) return;
    urls.add(url);
    const decoded = decodeSafeLink(url);
    if (decoded && decoded !== url) urls.add(decoded);
  };
  const $ = cheerio.load(html);
  $("[href],[src],[data-src],[data-url],[data-href],[onclick]").each((_, element) => {
    for (const attr of ["href", "src", "data-src", "data-url", "data-href"]) add($(element).attr(attr));
    const onclick = $(element).attr("onclick") || "";
    for (const match of onclick.match(/https?:[^'"\s)]+/g) || []) add(match);
  });
  for (const match of html.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || []) add(match);
  for (const token of html.match(/[A-Za-z0-9+/_-]{24,}={0,2}/g) || []) {
    const decoded = decodeBase64(token);
    if (decoded) add(decoded);
  }
  return [...urls];
}

function parsePanelUrl(url) {
  try {
    const parsed = new URL(url);
    const panel = parsed.hostname.match(/^painel(\d+)\.novefx\.biz$/i);
    const codeMatch = parsed.pathname.match(/\/v\/([A-Za-z]+)[-_]?(\d+)\/?$/i);
    if (!panel || !codeMatch) return null;
    return {
      panelUrl: parsed.href,
      storage: Number(panel[1]),
      code: codeMatch[1].toUpperCase(),
      currentEpisode: Number(codeMatch[2])
    };
  } catch { return null; }
}

function parseMediaUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/storage(\d+)\/([^/]+)\/([^/]+)-(\d+)\.(mp4|m3u8)$/i);
    if (!match) return null;
    return {
      mediaUrl: parsed.href,
      storage: Number(match[1]),
      folder: match[2],
      code: match[3],
      currentEpisode: Number(match[4]),
      extension: match[5].toLowerCase()
    };
  } catch { return null; }
}

function patternFromPanel(panelInfo) {
  return {
    ...panelInfo,
    folder: panelInfo.code,
    extension: "mp4",
    mediaUrl: `${config.cdnHost}/storage${panelInfo.storage}/${panelInfo.code}/${panelInfo.code}-${String(panelInfo.currentEpisode).padStart(3, "0")}.mp4`
  };
}

function episodeUrl(pattern, episode) {
  return `${config.cdnHost}/storage${pattern.storage}/${pattern.folder}/${pattern.code}-${String(episode).padStart(3, "0")}.${pattern.extension}`;
}

async function discoverLatest(pattern) {
  let latest = Math.max(1, pattern.currentEpisode || 1);
  for (let candidate = latest + 1; candidate <= latest + config.maxFutureEpisodeChecks; candidate += 1) {
    if (!(await urlExists(episodeUrl(pattern, candidate)))) break;
    latest = candidate;
  }
  return latest;
}

async function browserInstance() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = require("puppeteer");
      return puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
      });
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function resolveWithBrowser(pageUrl) {
  let release;
  const previous = browserQueue;
  browserQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  let page;
  try {
    const browser = await browserInstance();
    page = await browser.newPage();
    await page.setUserAgent(config.userAgent);
    await page.setRequestInterception(true);
    const observed = new Set();
    page.on("request", (request) => {
      observed.add(request.url());
      const type = request.resourceType();
      if (["image", "font", "stylesheet", "media"].includes(type)) request.abort();
      else request.continue();
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: config.browserTimeoutMs });
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const domUrls = await page.evaluate(() => {
      const values = [];
      document.querySelectorAll("a,iframe,button,[data-url],[data-href]").forEach((node) => {
        for (const key of ["href", "src", "data-url", "data-href", "onclick"]) {
          const value = node.getAttribute(key);
          if (value) values.push(value);
        }
      });
      return values;
    });
    for (const value of domUrls) {
      const url = absoluteUrl(value, page.url());
      if (url) observed.add(url);
    }

    for (const candidate of [...observed]) {
      const decoded = decodeSafeLink(candidate);
      const panel = parsePanelUrl(decoded);
      if (panel) return patternFromPanel(panel);
      const media = parseMediaUrl(decoded);
      if (media) return media;
    }

    const clicked = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("a,button")];
      const target = nodes.find((node) => /assistir/i.test(node.textContent || ""));
      if (!target) return false;
      target.click();
      return true;
    });
    if (clicked) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      for (const candidate of [...observed, page.url()]) {
        const decoded = decodeSafeLink(candidate);
        const panel = parsePanelUrl(decoded);
        if (panel) return patternFromPanel(panel);
        const media = parseMediaUrl(decoded);
        if (media) return media;
      }
    }
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

async function resolvePlayer(pageUrl, contentKey) {
  const cached = resolverCache.get(contentKey);
  if (cached) return cached;

  const known = config.knownPlayers[contentKey];
  if (known?.panelUrl) {
    const panel = parsePanelUrl(known.panelUrl);
    if (panel) {
      const pattern = patternFromPanel(panel);
      pattern.latestEpisode = await discoverLatest(pattern);
      return resolverCache.set(contentKey, pattern);
    }
  }

  try {
    const page = await fetchText(pageUrl);
    for (const candidate of collectUrls(page.text, page.finalUrl)) {
      const decoded = decodeSafeLink(candidate);
      const media = parseMediaUrl(decoded);
      if (media) {
        media.latestEpisode = await discoverLatest(media);
        return resolverCache.set(contentKey, media);
      }
      const panel = parsePanelUrl(decoded);
      if (panel) {
        const pattern = patternFromPanel(panel);
        pattern.latestEpisode = await discoverLatest(pattern);
        return resolverCache.set(contentKey, pattern);
      }
    }
  } catch (error) {
    console.warn(`HTTP resolver falhou para ${contentKey}: ${error.message}`);
  }

  try {
    const pattern = await resolveWithBrowser(pageUrl);
    if (pattern) {
      pattern.latestEpisode = await discoverLatest(pattern);
      return resolverCache.set(contentKey, pattern);
    }
  } catch (error) {
    console.warn(`Browser resolver falhou para ${contentKey}: ${error.message}`);
  }

  return null;
}

module.exports = { resolvePlayer, episodeUrl, parseMediaUrl, parsePanelUrl };
