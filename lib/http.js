"use strict";

const config = require("./config");

async function request(url, options = {}) {
  const headers = {
    "user-agent": config.userAgent,
    accept: options.accept || "application/json,text/html;q=0.9,*/*;q=0.8",
    "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || config.requestTimeoutMs)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`HTTP ${response.status} em ${url}${body ? `: ${body.slice(0, 250)}` : ""}`);
    error.status = response.status;
    throw error;
  }

  return response;
}

async function getJson(url, options = {}) {
  const response = await request(url, { ...options, accept: "application/json" });
  return response.json();
}

async function getText(url, options = {}) {
  const response = await request(url, { ...options, accept: "text/html,*/*;q=0.8" });
  return { text: await response.text(), finalUrl: response.url };
}

module.exports = { request, getJson, getText };
