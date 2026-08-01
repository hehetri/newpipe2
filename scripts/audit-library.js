"use strict";

/**
 * Auditoria da biblioteca inteira: percorre todas as categorias, resolve os
 * players e grava audit-report.json com o que está reproduzível e o que não
 * tem fonte. Use `AUDIT_DEEP=1` para liberar o navegador headless e
 * `AUDIT_LIMIT=20` para uma amostra rápida.
 *
 *   npm run audit
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("../src/config");
const { getCategoryItems, getDetails } = require("../src/catalog");
const { mapWithConcurrency } = require("../src/http");

const concurrency = Math.max(1, Number(process.env.AUDIT_CONCURRENCY || 4));
const deep = !/^(?:0|false|no)$/i.test(String(process.env.AUDIT_DEEP || "0"));
const limit = Number(process.env.AUDIT_LIMIT || 0);

async function auditItem(item) {
  const detail = await getDetails(item.category, item.slug, {
    budgetMs: deep ? config.streamBudgetMs : config.metaBudgetMs * 3,
    deep
  });
  const players = detail.players || [];
  const patterns = players.filter((player) => player.kind === "pattern");
  const singles = players.filter((player) => player.kind === "single");

  return {
    id: detail.id,
    category: detail.category,
    name: detail.name,
    pageUrl: detail.pageUrl,
    poster: detail.poster,
    episodes: patterns.reduce((total, player) => total + Number(player.latestEpisode || 0), 0),
    patterns: patterns.map((player) => ({
      season: player.season,
      code: player.code,
      latestEpisode: player.latestEpisode,
      sampleUrl: player.mediaUrl
    })),
    singles: singles.map((player) => player.mediaUrl),
    playable: detail.episodic ? patterns.length > 0 : players.length > 0
  };
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    site: config.siteBase,
    deep,
    categories: {},
    summary: { total: 0, playable: 0, missing: 0 }
  };

  for (const category of config.categories) {
    let items = await getCategoryItems(category, config.catalogDeepBudgetMs);
    if (limit > 0) items = items.slice(0, limit);
    console.log(`${category.name}: ${items.length} itens; auditando...`);

    const audited = (await mapWithConcurrency(items, concurrency, auditItem))
      .map((entry, index) => (entry?.error ? { id: items[index].id, error: entry.error.message, playable: false } : entry));
    const playable = audited.filter((entry) => entry?.playable).length;

    report.categories[category.key] = {
      total: audited.length,
      playable,
      missing: audited.length - playable,
      items: audited
    };
    report.summary.total += audited.length;
    report.summary.playable += playable;
    report.summary.missing += audited.length - playable;
    console.log(`  reproduzíveis: ${playable}/${audited.length}`);
  }

  const output = path.resolve(process.cwd(), process.env.AUDIT_OUTPUT || "audit-report.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Relatório: ${output}`);
  console.log(`Cobertura: ${report.summary.playable}/${report.summary.total}; faltando: ${report.summary.missing}`);

  // Resoluções em segundo plano podem continuar pendentes; encerramos aqui.
  process.exit(report.summary.missing > 0 ? 2 : 0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
