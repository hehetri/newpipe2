"use strict";

const config = require("./config");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseHeaders(userAgent, options = {}) {
  return {
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
    "cache-control": "no-cache",
    referer: options.referer || `${config.siteBase}/`,
    ...(options.headers || {})
  };
}

/**
 * GET com timeout, tentativas e troca de user-agent. Um 403/429/5xx do
 * WordPress ou do Cloudflare deixa de derrubar a varredura inteira.
 */
async function fetchText(url, options = {}) {
  const attempts = Math.max(1, Number(options.retries ?? config.requestRetries));
  const timeout = Number(options.timeout || config.requestTimeoutMs);
  const agents = [config.userAgent, ...config.fallbackUserAgents];
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const userAgent = agents[attempt % agents.length];
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
        headers: baseHeaders(userAgent, options)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
      return { text: await response.text(), finalUrl: response.url || url, status: response.status, headers: response.headers };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Falha ao buscar ${url}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetchText(url, {
    ...options,
    headers: { accept: "application/json, text/plain;q=0.8, */*;q=0.5", ...(options.headers || {}) }
  });
  return JSON.parse(response.text);
}

/** Verifica se uma mídia existe sem baixar o arquivo inteiro. */
async function urlExists(url, timeout = config.mediaCheckTimeoutMs) {
  if (!url) return false;
  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      headers: { "user-agent": config.userAgent }
    });
    if (response.ok) return true;
    if ([403, 405, 501].includes(response.status)) {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
        headers: { "user-agent": config.userAgent, Range: "bytes=0-0" }
      });
      return response.ok || response.status === 206;
    }
  } catch {}
  return false;
}

/** Executa tarefas com concorrência limitada, preservando a ordem do resultado. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { fetchText, fetchJson, urlExists, mapWithConcurrency, sleep };
