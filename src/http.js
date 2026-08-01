"use strict";

const config = require("./config");

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeout || config.requestTimeoutMs),
    headers: {
      "user-agent": config.userAgent,
      "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
      "referer": options.referer || config.siteBase + "/",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
  return { text: await response.text(), finalUrl: response.url, headers: response.headers };
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

module.exports = { fetchText, urlExists };
