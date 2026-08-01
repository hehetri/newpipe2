"use strict";

const cheerio = require("cheerio");
const config = require("./config");
const { fetchText, urlExists } = require("./http");
const { TTLCache } = require("./cache");

const resolverCache = new TTLCache(config.resolverCacheMs);
let browserPromise = null;
let browserQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function absoluteUrl(value, base = config.siteBase) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .trim();
  try { return new URL(cleaned, base).href; } catch { return null; }
}

function tryUrlDecode(value) {
  let current = String(value || "");
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch { break; }
  }
  return current;
}

function decodeBase64Payload(value) {
  try {
    const normalized = tryUrlDecode(value)
      .replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length < 16) return null;
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
    if (decoded.startsWith("//")) return `https:${decoded}`;
    const parsed = JSON.parse(decoded);
    for (const key of ["safelink", "second_safelink_url", "url", "link", "redirect", "target", "src", "file"]) {
      const candidate = parsed?.[key];
      if (typeof candidate === "string" && (/^https?:\/\//i.test(candidate) || candidate.startsWith("//"))) {
        return candidate.startsWith("//") ? `https:${candidate}` : candidate;
      }
    }
  } catch {}
  return null;
}

function expandEncodedValue(raw, base = config.siteBase) {
  const output = new Set();
  const queue = [String(raw || "")];

  while (queue.length && output.size < 12) {
    let value = queue.shift();
    if (!value) continue;
    value = tryUrlDecode(value)
      .replace(/&amp;/gi, "&")
      .replace(/\\\//g, "/")
      .trim();

    const absolute = absoluteUrl(value, base);
    if (absolute && !output.has(absolute)) output.add(absolute);

    const directBase64 = decodeBase64Payload(value);
    if (directBase64 && !output.has(directBase64)) queue.push(directBase64);

    try {
      const parsed = new URL(absolute || value, base);
      const bare = parsed.search.slice(1);
      if (bare && !bare.includes("=")) {
        const decoded = decodeBase64Payload(bare);
        if (decoded) queue.push(decoded);
      }
      for (const [key, paramValue] of parsed.searchParams) {
        if (/safe|redirect|url|link|target|dest|go|r/i.test(key)) {
          const decoded = decodeBase64Payload(paramValue) || tryUrlDecode(paramValue);
          if (decoded && decoded !== paramValue) queue.push(decoded);
        }
      }
    } catch {}
  }

  return [...output];
}

function labelFromNode($, node) {
  const element = $(node);
  return String(
    element.attr("aria-label") ||
    element.attr("title") ||
    element.attr("data-title") ||
    element.text() ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 160);
}

function collectCandidates(html, baseUrl) {
  const found = new Map();
  const add = (value, label = "") => {
    if (!value) return;
    for (const url of expandEncodedValue(value, baseUrl)) {
      const previous = found.get(url);
      if (!previous || (!previous.label && label)) found.set(url, { url, label });
    }
  };

  const $ = cheerio.load(html || "");
  $("*").each((_, node) => {
    const label = labelFromNode($, node);
    const attributes = node.attribs || {};
    for (const [name, value] of Object.entries(attributes)) {
      if (/^(?:href|src|action|data-|on)/i.test(name) || /url|link|player|embed|redirect|safe/i.test(name)) {
        add(value, label);
      }
    }
  });

  const normalized = String(html || "").replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
  const urlRegex = /(?:https?:)?\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;
  for (const match of normalized.match(urlRegex) || []) add(match.startsWith("//") ? `https:${match}` : match);

  const atobRegex = /atob\(\s*["']([^"']+)["']\s*\)/gi;
  let atobMatch;
  while ((atobMatch = atobRegex.exec(normalized))) {
    const decoded = decodeBase64Payload(atobMatch[1]);
    if (decoded) add(decoded);
  }

  const base64Regex = /[A-Za-z0-9+/_-]{28,}={0,2}/g;
  for (const token of normalized.match(base64Regex) || []) {
    const decoded = decodeBase64Payload(token);
    if (decoded) add(decoded);
  }

  return [...found.values()];
}

function seasonFromLabel(label) {
  const text = String(label || "");
  const match = text.match(/(?:temporada|season|temp\.?|t)\s*[:._-]?\s*(\d{1,2})/i);
  return match ? Math.max(1, Number(match[1])) : 1;
}

function parsePanelUrl(rawUrl, label = "") {
  for (const candidate of expandEncodedValue(rawUrl)) {
    try {
      const parsed = new URL(candidate);
      const panelMatch = parsed.hostname.match(/^painel(\d+)\.novefx\.biz$/i);
      const pathMatch = parsed.pathname.match(/\/(?:v|video|embed|player)\/([^/?#]+)\/?$/i);
      if (!panelMatch || !pathMatch) continue;

      const token = decodeURIComponent(pathMatch[1]);
      const codeMatch = token.match(/^(.+?)[-_]?(\d{1,5})$/i);
      if (!codeMatch) continue;
      const code = codeMatch[1].replace(/[-_]+$/, "").toUpperCase();
      const currentEpisode = Number(codeMatch[2]);
      const storage = Number(panelMatch[1]);
      if (!code || !Number.isInteger(currentEpisode) || currentEpisode < 1) continue;

      return {
        kind: "pattern",
        source: "panel",
        panelUrl: parsed.href,
        storage,
        folder: code,
        code,
        season: seasonFromLabel(label),
        currentEpisode,
        latestEpisode: currentEpisode,
        extension: "mp4",
        basePath: `${config.cdnHost}/storage${storage}/${encodeURIComponent(code)}/`,
        mediaUrl: `${config.cdnHost}/storage${storage}/${encodeURIComponent(code)}/${encodeURIComponent(code)}-${String(currentEpisode).padStart(3, "0")}.mp4`
      };
    } catch {}
  }
  return null;
}

function parseMediaUrl(rawUrl, label = "") {
  for (const candidate of expandEncodedValue(rawUrl)) {
    try {
      const parsed = new URL(candidate);
      if (!/\.(?:mp4|m3u8)(?:$|\?)/i.test(parsed.href)) continue;
      const match = parsed.pathname.match(/^(.*\/)([^/]+?)-(\d{1,5})\.(mp4|m3u8)$/i);
      if (!match) {
        return {
          kind: "single",
          source: "direct",
          season: seasonFromLabel(label),
          mediaUrl: parsed.href,
          extension: parsed.pathname.toLowerCase().endsWith(".m3u8") ? "m3u8" : "mp4"
        };
      }
      return {
        kind: "pattern",
        source: "direct",
        season: seasonFromLabel(label),
        folder: decodeURIComponent(match[1].split("/").filter(Boolean).at(-1) || ""),
        code: decodeURIComponent(match[2]),
        currentEpisode: Number(match[3]),
        latestEpisode: Number(match[3]),
        extension: match[4].toLowerCase(),
        basePath: `${parsed.origin}${match[1]}`,
        mediaUrl: parsed.href
      };
    } catch {}
  }
  return null;
}

function episodeUrl(pattern, episode) {
  if (!pattern || pattern.kind === "single") return pattern?.mediaUrl || null;
  return `${pattern.basePath}${encodeURIComponent(pattern.code)}-${String(episode).padStart(3, "0")}.${pattern.extension}`;
}

function sourceKey(source) {
  if (source.kind === "single") return `single:${source.season}:${source.mediaUrl}`;
  return `pattern:${source.season}:${source.basePath}:${source.code}:${source.extension}`;
}

function mergeSources(sources) {
  const merged = new Map();
  for (const source of sources) {
    if (!source) continue;
    const key = sourceKey(source);
    const previous = merged.get(key);
    if (!previous || Number(source.latestEpisode || 0) > Number(previous.latestEpisode || 0)) {
      merged.set(key, source);
    }
  }
  return [...merged.values()].sort((a, b) =>
    Number(a.season || 1) - Number(b.season || 1) ||
    Number(a.latestEpisode || 0) - Number(b.latestEpisode || 0)
  );
}

async function discoverLatest(source) {
  if (!source || source.kind !== "pattern") return source;
  let latest = Math.max(1, Number(source.latestEpisode || source.currentEpisode || 1));
  const limit = latest + config.maxFutureEpisodeChecks;
  for (let candidate = latest + 1; candidate <= limit; candidate += 1) {
    if (!(await urlExists(episodeUrl(source, candidate)))) break;
    latest = candidate;
  }
  return { ...source, latestEpisode: latest };
}

function promisingUrl(url) {
  return /novefx\.biz|cdn-novflix\.com|esportesdavez|safe|redirect|player|embed|\.mp4(?:\?|$)|\.m3u8(?:\?|$)/i.test(url) ||
    /[?&][^=]*(?:url|link|go|r|redirect|safe)[^=]*=/i.test(url) ||
    /\?[A-Za-z0-9+/_-]{24,}={0,2}$/.test(url);
}

async function resolveCandidate(rawUrl, label = "", depth = 0, seen = new Set(), budget = { fetches: 0 }) {
  if (!rawUrl || depth > 5 || budget.fetches > 45) return [];
  const results = [];

  for (const expanded of expandEncodedValue(rawUrl)) {
    const panel = parsePanelUrl(expanded, label);
    if (panel) results.push(panel);
    const media = parseMediaUrl(expanded, label);
    if (media) results.push(media);
  }
  if (results.length) return mergeSources(results);

  const url = expandEncodedValue(rawUrl)[0];
  if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) return [];
  seen.add(url);
  budget.fetches += 1;

  try {
    const page = await fetchText(url, { referer: config.siteBase + "/" });
    const candidates = collectCandidates(page.text, page.finalUrl);
    for (const candidate of candidates.slice(0, 80)) {
      if (!promisingUrl(candidate.url)) continue;
      results.push(...await resolveCandidate(candidate.url, candidate.label || label, depth + 1, seen, budget));
      if (results.length >= 8) break;
    }
  } catch {}

  return mergeSources(results);
}

async function resolveFromWordPress(pageUrl, contentKey) {
  const results = [];
  try {
    const parsed = new URL(pageUrl);
    const slug = parsed.pathname.split("/").filter(Boolean).at(-1) || contentKey.split("-").slice(1).join("-");
    const searchTerm = slug.replace(/-/g, " ");
    const searchUrl = `${parsed.origin}/wp-json/wp/v2/search?search=${encodeURIComponent(searchTerm)}&per_page=20`;
    const searchResponse = await fetchText(searchUrl, { referer: pageUrl });
    const entries = JSON.parse(searchResponse.text);
    if (!Array.isArray(entries)) return [];

    for (const entry of entries.slice(0, 10)) {
      const urls = new Set();
      if (entry?.url) urls.add(entry.url);
      const self = entry?._links?.self;
      if (Array.isArray(self)) for (const link of self) if (link?.href) urls.add(link.href);
      if (entry?.id && entry?.subtype) {
        const bases = [entry.subtype, `${entry.subtype}s`];
        for (const restBase of bases) urls.add(`${parsed.origin}/wp-json/wp/v2/${restBase}/${entry.id}?context=view`);
      }
      for (const url of urls) {
        try {
          const response = await fetchText(url, { referer: pageUrl });
          for (const candidate of collectCandidates(response.text, response.finalUrl)) {
            if (!promisingUrl(candidate.url)) continue;
            results.push(...await resolveCandidate(candidate.url, candidate.label, 0));
          }
        } catch {}
      }
      if (results.length) break;
    }
  } catch {}
  return mergeSources(results);
}

async function browserInstance() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = require("puppeteer");
      return puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--disable-background-networking"
        ]
      });
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function createObservationState() {
  const observed = new Map();
  const bodies = [];
  return {
    observed,
    bodies,
    addUrl(url, label = "") {
      if (!url) return;
      const previous = observed.get(url);
      if (!previous || (!previous && label)) observed.set(url, label || "");
    },
    addBody(text, url, label = "") {
      if (!text || bodies.length >= 80) return;
      bodies.push({ text: String(text).slice(0, 2_000_000), url, label });
    }
  };
}

async function setupBrowserPage(page, state, pageLabels) {
  pageLabels.set(page, pageLabels.get(page) || "");
  await page.setUserAgent(config.userAgent);
  await page.setViewport({ width: 1365, height: 900 });
  await page.evaluateOnNewDocument(() => {
    window.__nfCapturedUrls = [];
    const originalOpen = window.open;
    window.open = function patchedOpen(url, ...args) {
      try { if (url) window.__nfCapturedUrls.push(String(url)); } catch {}
      try { return originalOpen.call(window, url, ...args); } catch { return null; }
    };
    document.addEventListener("click", (event) => {
      try {
        const node = event.target?.closest?.("a,button,[onclick],[data-url],[data-href]");
        if (!node) return;
        for (const key of ["href", "src", "data-url", "data-href", "onclick"]) {
          const value = node.getAttribute?.(key);
          if (value) window.__nfCapturedUrls.push(value);
        }
      } catch {}
    }, true);
  });

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    state.addUrl(request.url(), pageLabels.get(page) || "");
    const type = request.resourceType();
    if (["image", "font", "media"].includes(type)) request.abort().catch(() => {});
    else request.continue().catch(() => {});
  });
  page.on("response", async (response) => {
    const url = response.url();
    state.addUrl(url, pageLabels.get(page) || "");
    const contentType = String(response.headers()["content-type"] || "");
    if (!/(?:text|json|javascript|xml|html)/i.test(contentType)) return;
    try {
      const text = await response.text();
      state.addBody(text, url, pageLabels.get(page) || "");
    } catch {}
  });
  page.on("popup", async (popup) => {
    pageLabels.set(popup, pageLabels.get(page) || "");
    await setupBrowserPage(popup, state, pageLabels).catch(() => {});
  });
}

async function collectPageState(page, state) {
  if (page.isClosed()) return;
  state.addUrl(page.url());
  for (const frame of page.frames()) {
    try {
      const html = await frame.content();
      state.addBody(html, frame.url());
    } catch {}
    try {
      const captured = await frame.evaluate(() => window.__nfCapturedUrls || []);
      for (const value of captured) state.addUrl(absoluteUrl(value, frame.url()));
    } catch {}
  }
}

async function sourcesFromObservation(state) {
  const results = [];
  for (const [url, label] of state.observed) {
    const panel = parsePanelUrl(url, label);
    if (panel) results.push(panel);
    const media = parseMediaUrl(url, label);
    if (media) results.push(media);
  }
  if (results.length) return mergeSources(results);

  for (const body of state.bodies) {
    for (const candidate of collectCandidates(body.text, body.url)) {
      const panel = parsePanelUrl(candidate.url, candidate.label || body.label);
      if (panel) results.push(panel);
      const media = parseMediaUrl(candidate.url, candidate.label || body.label);
      if (media) results.push(media);
    }
  }
  if (results.length) return mergeSources(results);

  const candidates = [];
  for (const body of state.bodies) {
    for (const candidate of collectCandidates(body.text, body.url)) {
      if (promisingUrl(candidate.url)) candidates.push(candidate);
    }
  }
  for (const candidate of candidates.slice(0, 60)) {
    results.push(...await resolveCandidate(candidate.url, candidate.label, 0));
    if (results.length >= 8) break;
  }
  return mergeSources(results);
}

async function resolveWithBrowser(pageUrl) {
  let release;
  const previous = browserQueue;
  browserQueue = new Promise((resolve) => { release = resolve; });
  await previous;

  let context;
  try {
    const browser = await browserInstance();
    context = await browser.createBrowserContext();
    const state = createObservationState();
    const pageLabels = new Map();
    const page = await context.newPage();
    await setupBrowserPage(page, state, pageLabels);

    context.on("targetcreated", async (target) => {
      try {
        const popup = await target.page();
        if (!popup || pageLabels.has(popup)) return;
        pageLabels.set(popup, pageLabels.get(page) || "");
        await setupBrowserPage(popup, state, pageLabels);
      } catch {}
    });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: config.browserTimeoutMs });
    await sleep(2500);
    for (const openPage of await context.pages()) await collectPageState(openPage, state);
    let sources = await sourcesFromObservation(state);
    if (sources.length) return sources;

    const clickTargets = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("a,button,[role='button'],[onclick],[data-url],[data-href],.btn,.button")];
      const items = [];
      nodes.forEach((node, index) => {
        const text = String(node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const attrs = ["href", "src", "data-url", "data-href", "onclick"].map((key) => node.getAttribute(key)).filter(Boolean).join(" ");
        const score = (/assistir|epis[oó]dio|temporada|player|play|ver agora/i.test(`${text} ${attrs}`) ? 100 : 0) +
          (/safe|redirect|novefx|esportesdavez/i.test(attrs) ? 80 : 0) +
          (node.tagName === "A" ? 5 : 0);
        if (score > 0) {
          const marker = `nf-probe-${index}`;
          node.setAttribute("data-nf-probe", marker);
          items.push({ marker, label: text.slice(0, 160), score });
        }
      });
      return items.sort((a, b) => b.score - a.score).slice(0, 16);
    });

    for (const target of clickTargets) {
      if (page.isClosed()) break;
      pageLabels.set(page, target.label || "");
      try {
        await page.evaluate((marker) => {
          const node = document.querySelector(`[data-nf-probe="${marker}"]`);
          if (!node) return;
          node.scrollIntoView({ block: "center", inline: "center" });
          node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          if (typeof node.click === "function") node.click();
        }, target.marker);
      } catch {}
      await sleep(1800);
      for (const openPage of await context.pages()) {
        if (!pageLabels.has(openPage)) {
          pageLabels.set(openPage, target.label || "");
          await setupBrowserPage(openPage, state, pageLabels).catch(() => {});
        }
        await collectPageState(openPage, state);
      }
      sources = await sourcesFromObservation(state);
      if (sources.length) return sources;
    }

    return [];
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

async function resolvePlayers(pageUrl, contentKey) {
  const cached = resolverCache.get(contentKey);
  if (cached) return cached;
  const results = [];

  try {
    const page = await fetchText(pageUrl);
    for (const candidate of collectCandidates(page.text, page.finalUrl)) {
      if (!promisingUrl(candidate.url)) continue;
      results.push(...await resolveCandidate(candidate.url, candidate.label, 0));
      if (results.length >= 8) break;
    }
  } catch (error) {
    console.warn(`Resolver HTTP ${contentKey}: ${error.message}`);
  }

  if (!results.length) {
    results.push(...await resolveFromWordPress(pageUrl, contentKey));
  }

  if (!results.length) {
    try { results.push(...await resolveWithBrowser(pageUrl)); }
    catch (error) { console.warn(`Resolver browser ${contentKey}: ${error.message}`); }
  }

  if (!results.length && config.knownPlayers?.[contentKey]?.panelUrl) {
    const fallback = parsePanelUrl(config.knownPlayers[contentKey].panelUrl);
    if (fallback) results.push(fallback);
  }

  const finalSources = [];
  for (const source of mergeSources(results)) finalSources.push(await discoverLatest(source));
  resolverCache.set(contentKey, finalSources);
  return finalSources;
}

module.exports = {
  resolvePlayers,
  episodeUrl,
  parseMediaUrl,
  parsePanelUrl,
  collectCandidates,
  expandEncodedValue
};
