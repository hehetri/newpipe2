"use strict";

const config = require("./config");
const { getText } = require("./http");
const { TTLCache } = require("./cache");

const cache = new TTLCache(config.cacheMs);

function padEpisode(value) {
  return String(value).padStart(3, "0");
}

function cleanUrl(value, base) {
  if (!value) return null;
  const normalized = String(value)
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/")
    .trim();
  try {
    return new URL(normalized, base).href;
  } catch {
    return null;
  }
}

function decodeBase64Payload(value) {
  try {
    const input = decodeURIComponent(String(value))
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();

    if (/^https?:\/\//i.test(decoded)) return decoded;

    const parsed = JSON.parse(decoded);
    for (const key of ["safelink", "second_safelink_url", "url", "src", "file"]) {
      if (typeof parsed?.[key] === "string" && /^https?:\/\//i.test(parsed[key])) {
        return parsed[key];
      }
    }
  } catch {}
  return null;
}

function decodeSafeLink(raw) {
  let current = raw;
  for (let pass = 0; pass < 4; pass += 1) {
    try {
      const parsed = new URL(current);
      let decoded = null;

      const bare = parsed.search.slice(1);
      if (bare && /^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(bare)) {
        decoded = decodeBase64Payload(bare);
      }

      if (!decoded) {
        for (const [key, value] of parsed.searchParams) {
          if (/safelink|redirect/i.test(key)) {
            decoded = decodeBase64Payload(value);
            if (decoded) break;
          }
        }
      }

      if (!decoded || decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function parsePanelUrl(rawUrl) {
  try {
    const url = new URL(decodeSafeLink(rawUrl));
    const hostMatch = url.hostname.match(/^painel(\d+)\.novefx\.biz$/i);
    const pathMatch = url.pathname.match(/\/v\/([A-Za-z][A-Za-z0-9_-]*?)(\d+)\/?$/i);
    if (!hostMatch || !pathMatch) return null;

    const storage = Number(hostMatch[1]);
    const code = pathMatch[1].replace(/[-_]+$/, "").toUpperCase();
    const latestEpisode = Number(pathMatch[2]);
    if (!Number.isInteger(storage) || !code || !Number.isInteger(latestEpisode)) return null;

    return {
      kind: "pattern",
      source: "panel",
      storage,
      code,
      latestEpisode,
      extension: "mp4",
      basePath: `${config.cdnOrigin}/storage${storage}/${encodeURIComponent(code)}/`,
      sampleUrl: `${config.cdnOrigin}/storage${storage}/${encodeURIComponent(code)}/${encodeURIComponent(code)}-${padEpisode(latestEpisode)}.mp4`
    };
  } catch {
    return null;
  }
}

function parseDirectMedia(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/^(.*\/)([^/]+)-(\d+)\.(mp4|m3u8)$/i);
    if (!match) {
      return {
        kind: "single",
        source: "direct",
        url: url.href,
        extension: url.pathname.toLowerCase().endsWith(".m3u8") ? "m3u8" : "mp4"
      };
    }

    return {
      kind: "pattern",
      source: "direct",
      code: decodeURIComponent(match[2]),
      latestEpisode: Number(match[3]),
      extension: match[4].toLowerCase(),
      basePath: `${url.origin}${match[1]}`,
      sampleUrl: url.href
    };
  } catch {
    return null;
  }
}

function extractUrls(html, baseUrl) {
  const urls = new Set();
  const add = (value) => {
    const url = cleanUrl(value, baseUrl);
    if (!url) return;
    urls.add(url);
    const decoded = decodeSafeLink(url);
    if (decoded && decoded !== url) urls.add(decoded);
  };

  const attrRegex = /(?:src|href|data-src|data-url|file)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRegex.exec(html))) add(match[1]);

  const urlRegex = /https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;
  for (const item of html.match(urlRegex) || []) add(item);

  const base64Regex = /[A-Za-z0-9+/_-]{28,}={0,2}/g;
  for (const token of html.match(base64Regex) || []) {
    const decoded = decodeBase64Payload(token);
    if (decoded) add(decoded);
  }

  return [...urls];
}

function extractDirectFromHtml(html, baseUrl) {
  const regexes = [
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(html))) {
      const url = cleanUrl(match[1], baseUrl);
      if (url) return url;
    }
  }
  return null;
}

function seasonFromLabel(label) {
  const text = String(label || "");
  const explicit = text.match(/(?:temporada|season|s)[\s._:-]*(\d{1,2})/i);
  return explicit ? Math.max(1, Number(explicit[1])) : 1;
}

async function resolveUrl(rawUrl, label = "", depth = 0, seen = new Set()) {
  if (!rawUrl || depth > 4) return [];
  const decoded = decodeSafeLink(rawUrl);
  if (seen.has(decoded)) return [];
  seen.add(decoded);

  const season = seasonFromLabel(label);
  const panel = parsePanelUrl(decoded);
  if (panel) return [{ ...panel, season, label }];

  if (/\.(mp4|m3u8)(?:\?|$)/i.test(decoded)) {
    const media = parseDirectMedia(decoded);
    return media ? [{ ...media, season, label }] : [];
  }

  try {
    const page = await getText(decoded);
    const direct = extractDirectFromHtml(page.text, page.finalUrl);
    if (direct) {
      const media = parseDirectMedia(direct);
      if (media) return [{ ...media, season, label }];
    }

    const nested = extractUrls(page.text, page.finalUrl).filter((url) =>
      /novefx\.biz\/v\//i.test(url) ||
      /esportesdavez\.com/i.test(url) ||
      /\.(mp4|m3u8)(?:\?|$)/i.test(url)
    );

    const results = [];
    for (const candidate of nested.slice(0, 30)) {
      results.push(...await resolveUrl(candidate, label, depth + 1, seen));
    }
    return results;
  } catch {
    return [];
  }
}

function mergePatterns(resolved) {
  const map = new Map();
  for (const item of resolved) {
    if (!item) continue;
    if (item.kind === "single") {
      const key = `single:${item.season}:${item.url}`;
      map.set(key, item);
      continue;
    }

    const key = `pattern:${item.season}:${item.basePath}:${item.code}:${item.extension}`;
    const previous = map.get(key);
    if (!previous || item.latestEpisode > previous.latestEpisode) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) =>
    (a.season - b.season) || ((a.latestEpisode || 0) - (b.latestEpisode || 0))
  );
}

async function resolvePlayers(players = []) {
  const key = JSON.stringify(players);
  const cached = cache.get(key);
  if (cached) return cached;

  const resolved = [];
  for (const player of players) {
    const label = typeof player === "string" ? "" : player.label;
    const url = typeof player === "string" ? player : player.url;
    resolved.push(...await resolveUrl(url, label));
  }

  return cache.set(key, mergePatterns(resolved));
}

function episodeUrl(pattern, episode) {
  return `${pattern.basePath}${encodeURIComponent(pattern.code)}-${padEpisode(episode)}.${pattern.extension}`;
}

module.exports = {
  decodeSafeLink,
  parsePanelUrl,
  parseDirectMedia,
  resolvePlayers,
  episodeUrl
};
