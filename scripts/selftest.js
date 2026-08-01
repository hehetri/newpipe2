"use strict";

/**
 * Teste de ponta a ponta do addon contra um NoveFlix falso (WordPress + CDN).
 * Cobre catálogo por REST, catálogo por HTML (permalink canônico e permalink
 * raso), metadata, streams, item fora do catálogo e site fora do ar.
 *
 *   npm run selftest
 */

const http = require("node:http");

const SITE_PORT = Number(process.env.SELFTEST_SITE_PORT || 18711);
const ADDON_PORT = Number(process.env.SELFTEST_ADDON_PORT || 18712);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const ADDON = `http://127.0.0.1:${ADDON_PORT}`;
const LAST_EPISODE = 65;

const NOVELAS = [
  { slug: "quem-ama-cuida", title: "Quem Ama Cuida", panel: "https://painel1.novefx.biz/v/QAC063" },
  { slug: "a-escrava-isaura", title: "A Escrava Isaura", panel: "https://painel6.novefx.biz/v/ESC167" },
  { slug: "terra-nostra", title: "Terra Nostra", panel: "https://painel2.novefx.biz/v/TNO010" }
];
const SHOWS = [
  { slug: "show-da-virada", title: "Show da Virada", panel: "https://painel3.novefx.biz/v/SDV004" },
  { slug: "musical-de-natal", title: "Musical de Natal", panel: "https://painel3.novefx.biz/v/MDN002" }
];
const PROGRAMAS = [
  { slug: "programa-da-tarde", title: "Programa da Tarde", panel: "https://painel4.novefx.biz/v/PDT012", flat: true },
  { slug: "domingo-especial", title: "Domingo Especial", panel: "https://painel4.novefx.biz/v/DOE003", flat: true }
];
const FILMES = [
  { slug: "filme-teste", title: "Filme Teste", media: "/cdn/filmes/filme-teste.mp4" }
];

const ALL = [...NOVELAS, ...SHOWS, ...PROGRAMAS, ...FILMES];
const bySlug = new Map(ALL.map((entry) => [entry.slug, entry]));

const pageUrlFor = (entry) => (entry.flat ? `${SITE}/${entry.slug}/` : `${SITE}/assista/${entry.slug}/`);

function postPage(entry) {
  const player = entry.media
    ? `<a class="player" href="${SITE}${entry.media}">Assistir agora</a>`
    : `<a class="player" href="${entry.panel}" title="Temporada 1">Assistir agora</a>`;
  return `<!doctype html><html><head>
<meta property="og:title" content="Assistir ${entry.title} Online">
<meta property="og:description" content="Sinopse de ${entry.title} no NoveFlix.">
<meta property="og:image" content="${SITE}/uploads/${entry.slug}.jpg">
</head><body><h1>${entry.title}</h1><p>Lançamento 2024.</p>${player}</body></html>`;
}

function archivePage(entries) {
  const cards = entries.map((entry) => `
    <article class="item">
      <a href="${pageUrlFor(entry)}"><img src="${SITE}/uploads/${entry.slug}.jpg" alt="${entry.title}"></a>
      <h2 class="title"><a href="${pageUrlFor(entry)}">${entry.title}</a></h2>
    </article>`).join("");
  return `<!doctype html><html><body>
    <nav><a href="${SITE}/">Início</a><a href="${SITE}/contato/">Contato</a></nav>
    <main>${cards}</main></body></html>`;
}

function restPost(entry, id) {
  return {
    id,
    slug: entry.slug,
    link: pageUrlFor(entry),
    title: { rendered: `Assistir ${entry.title} Online` },
    excerpt: { rendered: `<p>Sinopse de ${entry.title} no NoveFlix.</p>` },
    date: "2024-03-01T12:00:00",
    jetpack_featured_media_url: `${SITE}/uploads/${entry.slug}.jpg`
  };
}

function startFakeSite() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, SITE);
    const path = url.pathname;
    const json = (payload, headers = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const notFound = () => { res.writeHead(404); res.end("nao encontrado"); };

    // REST: categorias — só "novelas" e "filmes" existem, o resto cai no HTML.
    if (path === "/wp-json/wp/v2/categories") {
      const slug = url.searchParams.get("slug");
      if (["novelas", "novela"].includes(slug)) return json([{ id: 5, slug: "novelas", count: NOVELAS.length }]);
      if (["filmes", "filme"].includes(slug)) return json([{ id: 7, slug: "filmes", count: FILMES.length }]);
      return json([]);
    }

    // REST: posts por categoria ou por slug.
    if (path === "/wp-json/wp/v2/posts") {
      const slug = url.searchParams.get("slug");
      if (slug) {
        const entry = bySlug.get(slug);
        // Só as novelas e os filmes respondem por slug; o resto força o
        // caminho de descoberta por catálogo/candidatos de URL.
        const viaRest = entry && !entry.flat && !SHOWS.includes(entry);
        return json(viaRest ? [restPost(entry, 100)] : []);
      }
      const category = url.searchParams.get("categories");
      const entries = category === "5" ? NOVELAS : category === "7" ? FILMES : [];
      const page = Number(url.searchParams.get("page") || 1);
      if (page > 1) return json([], { "x-wp-totalpages": "1" });
      return json(entries.map((entry, index) => restPost(entry, index + 1)), { "x-wp-totalpages": "1" });
    }

    // Arquivos das categorias em HTML.
    if (path === "/categoria/shows/") return html(archivePage(SHOWS));
    if (path === "/categoria/programas/") return html(archivePage(PROGRAMAS));

    // Páginas dos conteúdos.
    const direct = path.match(/^\/(?:assista|assistir|ver|watch)\/([^/]+)\/?$/) || path.match(/^\/([^/]+)\/?$/);
    if (direct) {
      const entry = bySlug.get(direct[1]);
      if (entry) return html(postPage(entry));
    }

    // CDN: episódios existem até LAST_EPISODE.
    const episode = path.match(/^\/cdn\/storage\d+\/[^/]+\/[^/]+-(\d{1,5})\.mp4$/);
    if (episode) {
      if (Number(episode[1]) <= LAST_EPISODE) { res.writeHead(200, { "content-length": "1024" }); return res.end(); }
      return notFound();
    }
    if (path === "/cdn/filmes/filme-teste.mp4") { res.writeHead(200); return res.end(); }

    return notFound();
  });

  return new Promise((resolve) => server.listen(SITE_PORT, () => resolve(server)));
}

/* ------------------------------------------------------------------ */

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALHA ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function getJson(path) {
  const response = await fetch(`${ADDON}${path}`, { signal: AbortSignal.timeout(30000) });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const site = await startFakeSite();

  process.env.PORT = String(ADDON_PORT);
  process.env.NOVEFLIX_SITE = SITE;
  process.env.NOVEFLIX_CDN = `${SITE}/cdn`;
  process.env.NOVEFLIX_BROWSER = "0";
  process.env.NOVEFLIX_WARMUP = "0";
  process.env.NOVEFLIX_REQUEST_TIMEOUT_MS = "4000";

  const addon = require("../src/index.js").start();
  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log("\nManifest");
  const manifest = await getJson("/manifest.json");
  check("manifest responde 200", manifest.status === 200);
  check("5 catálogos publicados", manifest.body.catalogs?.length === 5, JSON.stringify(manifest.body.catalogs?.length));

  console.log("\nCatálogo via REST (novelas)");
  const novelas = await getJson("/catalog/series/noveflix-novelas.json");
  check("retorna itens", novelas.body.metas?.length >= NOVELAS.length, `recebeu ${novelas.body.metas?.length}`);
  check("id no formato antigo", novelas.body.metas?.some((meta) => meta.id === "noveflix:novelas-quem-ama-cuida"));
  check("título limpo", novelas.body.metas?.some((meta) => meta.name === "Quem Ama Cuida"));
  check("capa do site", novelas.body.metas?.every((meta) => Boolean(meta.poster)));

  console.log("\nCatálogo via HTML canônico (shows)");
  const shows = await getJson("/catalog/series/noveflix-shows.json");
  check("retorna itens", shows.body.metas?.length === SHOWS.length, `recebeu ${shows.body.metas?.length}`);
  check("sem links de menu", shows.body.metas?.every((meta) => !/contato|inicio/i.test(meta.id)));

  console.log("\nCatálogo via HTML com permalink raso (programas)");
  const programas = await getJson("/catalog/series/noveflix-programas.json");
  check("retorna itens", programas.body.metas?.length === PROGRAMAS.length, `recebeu ${programas.body.metas?.length}`);

  console.log("\nCatálogo de filmes");
  const filmes = await getJson("/catalog/movie/noveflix-filmes.json");
  check("retorna itens", filmes.body.metas?.length === FILMES.length, `recebeu ${filmes.body.metas?.length}`);

  console.log("\nBusca");
  const busca = await getJson("/catalog/series/noveflix-novelas/search=escrava.json");
  check("filtra pelo termo", busca.body.metas?.length === 1 && busca.body.metas[0].id === "noveflix:novelas-a-escrava-isaura");

  console.log("\nMetadata (o erro do print)");
  let meta = await getJson("/meta/series/noveflix%3Anovelas-quem-ama-cuida.json");
  check("meta nunca é null", Boolean(meta.body.meta), JSON.stringify(meta.body));
  check("nome correto", meta.body.meta?.name === "Quem Ama Cuida", meta.body.meta?.name);
  check("sinopse da página", /Sinopse de Quem Ama Cuida/.test(meta.body.meta?.description || ""));
  check("capa da página", meta.body.meta?.poster?.endsWith("/uploads/quem-ama-cuida.jpg"), meta.body.meta?.poster);

  // A resolução completa termina em segundo plano; a segunda chamada já traz
  // a lista definitiva de episódios.
  for (let attempt = 0; attempt < 20 && (meta.body.meta?.videos?.length || 0) < LAST_EPISODE; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    meta = await getJson("/meta/series/noveflix%3Anovelas-quem-ama-cuida.json");
  }
  check(`${LAST_EPISODE} episódios descobertos`, meta.body.meta?.videos?.length === LAST_EPISODE, `recebeu ${meta.body.meta?.videos?.length}`);

  console.log("\nMetadata de item fora do catálogo");
  const desconhecido = await getJson("/meta/series/noveflix%3Anovelas-item-inexistente-999.json");
  check("responde com meta de fallback", Boolean(desconhecido.body.meta));
  check("nome derivado do slug", desconhecido.body.meta?.name === "Item Inexistente 999", desconhecido.body.meta?.name);

  console.log("\nStreams");
  const stream = await getJson("/stream/series/noveflix%3Anovelas-quem-ama-cuida%3A1%3A5.json");
  check("stream do episódio 5", stream.body.streams?.[0]?.url?.endsWith("/cdn/storage1/QAC/QAC-005.mp4"), stream.body.streams?.[0]?.url);
  const streamFilme = await getJson("/stream/movie/noveflix%3Afilmes-filme-teste.json");
  check("stream do filme", streamFilme.body.streams?.[0]?.url?.endsWith("/cdn/filmes/filme-teste.mp4"), streamFilme.body.streams?.[0]?.url);

  console.log("\nDiagnóstico");
  const health = await getJson("/health");
  check("health ok", health.body.ok === true);
  check("categorias reportadas", health.body.categories?.length === 5);
  const diag = await getJson("/diag/catalog/novelas");
  check("diag do catálogo", diag.body.total >= NOVELAS.length);

  console.log("\nSite fora do ar");
  site.closeAllConnections?.();
  await new Promise((resolve) => site.close(resolve));
  const offlineCatalog = await getJson("/catalog/series/noveflix-novelas.json");
  check("catálogo continua servindo cache", offlineCatalog.body.metas?.length >= NOVELAS.length, `recebeu ${offlineCatalog.body.metas?.length}`);
  const offlineMeta = await getJson("/meta/series/noveflix%3Anovelas-terra-nostra.json");
  check("metadata continua respondendo", Boolean(offlineMeta.body.meta));

  console.log("\nSite lento (o cenário que gerava \"Addon did not return metadata\")");
  const slowSite = http.createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); }, 30000);
  });
  await new Promise((resolve) => slowSite.listen(SITE_PORT, resolve));
  const startedAt = Date.now();
  const slowMeta = await getJson("/meta/series/noveflix%3Anovelas-conteudo-lento.json");
  const elapsed = Date.now() - startedAt;
  check("responde dentro do orçamento", elapsed < 15000, `${elapsed}ms`);
  check("ainda assim devolve metadata", Boolean(slowMeta.body.meta));
  slowSite.closeAllConnections?.();
  slowSite.close();

  addon.close();
  console.log(failures ? `\n${failures} verificação(ões) falharam.\n` : "\nTodas as verificações passaram.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
