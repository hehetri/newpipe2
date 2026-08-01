"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../lib/config");
const bridge = require("../lib/bridge-client");
const { resolvePlayers } = require("../lib/media-resolver");

const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY || 5));

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function listCategory(category) {
  const items = [];
  let page = 1;
  let pages = 1;

  do {
    const result = await bridge.catalog(category.key, page, 100, "");
    items.push(...(result.items || []));
    pages = Math.max(1, Number(result.pages || 1));
    page += 1;
  } while (page <= pages);

  return items;
}

async function auditItem(item) {
  const detail = await bridge.item(item.id, item.category);
  const media = await resolvePlayers(detail.players || []);
  const patterns = media.filter((entry) => entry.kind === "pattern");
  const singles = media.filter((entry) => entry.kind === "single");
  const playable = detail.episodic ? patterns.length > 0 : media.length > 0;

  return {
    id: item.id,
    category: item.category,
    title: item.title,
    url: item.url,
    playerCandidates: detail.players?.length || 0,
    resolvedSources: media.length,
    patterns: patterns.map((entry) => ({
      season: entry.season,
      code: entry.code,
      latestEpisode: entry.latestEpisode,
      sampleUrl: entry.sampleUrl
    })),
    singles: singles.map((entry) => entry.url),
    playable
  };
}

async function main() {
  const health = await bridge.health();
  console.log(`Bridge OK: ${health.site || config.bridgeUrl}`);

  const report = {
    generatedAt: new Date().toISOString(),
    bridge: config.bridgeUrl,
    categories: {},
    summary: { total: 0, playable: 0, missing: 0 }
  };

  for (const category of config.categories) {
    const items = await listCategory(category);
    console.log(`${category.name}: ${items.length} itens; auditando...`);
    const audited = await mapLimit(items, concurrency, auditItem);
    const playable = audited.filter((item) => item?.playable).length;
    const missing = audited.length - playable;

    report.categories[category.key] = {
      total: audited.length,
      playable,
      missing,
      items: audited
    };
    report.summary.total += audited.length;
    report.summary.playable += playable;
    report.summary.missing += missing;
  }

  const output = path.resolve(process.cwd(), process.env.AUDIT_OUTPUT || "audit-report.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Relatório: ${output}`);
  console.log(`Cobertura: ${report.summary.playable}/${report.summary.total}; faltando: ${report.summary.missing}`);

  if (report.summary.missing > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
