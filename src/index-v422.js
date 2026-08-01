"use strict";

const fs = require("node:fs");
const path = require("node:path");

const originalReadFileSync = fs.readFileSync;
const baseIndexPath = path.join(__dirname, "index.js");

fs.readFileSync = function patchedReadFileSync(file, options) {
  let source = originalReadFileSync.call(fs, file, options);

  if (path.resolve(String(file)) !== path.resolve(baseIndexPath) || typeof source !== "string") {
    return source;
  }

  const oldBaseLookup = `  const catalog = await scrapeCategory(category);
  const base = catalog.find((item) => item.slug === slug);
  if (!base) throw new Error(\`Conteúdo não encontrado: \${key}\`);

  let item = { ...base, players: [] };`;

  const newBaseLookup = `  let catalog = [];
  try {
    catalog = await scrapeCategory(category);
  } catch (error) {
    console.warn(\`Catálogo parcial para \${key}: \${error.message}\`);
  }

  const catalogItem = catalog.find((entry) => entry.slug === slug);
  const fallbackName = String(slug)
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1))
    .join(" ");

  const base = catalogItem || {
    id: metaId(categoryKey, slug),
    category: categoryKey,
    slug,
    pageUrl: new URL(\`/assista/\${slug}/\`, config.siteBase).href,
    type: category.type,
    episodic: category.episodic,
    name: fallbackName,
    poster: null,
    background: null,
    description: \`Assista \${fallbackName} no NoveFlix.\`,
    genres: [category.genre]
  };

  let resolvedPageUrl = base.pageUrl;
  let item = { ...base, players: [] };`;

  if (!source.includes(oldBaseLookup)) {
    throw new Error("Patch 4.2.2: bloco de busca do metadata não encontrado.");
  }
  source = source.replace(oldBaseLookup, newBaseLookup);

  const oldFetch = `    const response = await fetchText(base.pageUrl);`;
  const newFetch = `    let response = null;
    let lastPageError = null;
    const pageCandidates = [...new Set([
      base.pageUrl,
      new URL(\`/assista/\${slug}/\`, config.siteBase).href,
      new URL(\`/assistir/\${slug}/\`, config.siteBase).href,
      new URL(\`/ver/\${slug}/\`, config.siteBase).href
    ].filter(Boolean))];

    for (const candidate of pageCandidates) {
      try {
        response = await fetchText(candidate);
        resolvedPageUrl = response.finalUrl;
        break;
      } catch (error) {
        lastPageError = error;
      }
    }

    if (!response) {
      throw lastPageError || new Error(\`Página não localizada para \${key}\`);
    }`;

  if (!source.includes(oldFetch)) {
    throw new Error("Patch 4.2.2: fetch da página do metadata não encontrado.");
  }
  source = source.replace(oldFetch, newFetch);

  const oldResolver = `  item.players = await resolvePlayers(base.pageUrl, key);`;
  const newResolver = `  try {
    item.players = await resolvePlayers(resolvedPageUrl || base.pageUrl, key);
  } catch (error) {
    item.players = [];
    console.warn(\`Resolver falhou para \${key}: \${error.message}\`);
  }`;

  if (!source.includes(oldResolver)) {
    throw new Error("Patch 4.2.2: chamada do resolvedor não encontrada.");
  }
  source = source.replace(oldResolver, newResolver);

  const oldMetaCatch = `  } catch (error) {
    console.error(\`Meta \${id}: \${error.stack || error.message}\`);
    return { meta: null };
  }
});`;

  const newMetaCatch = `  } catch (error) {
    console.error(\`Meta \${id}: \${error.stack || error.message}\`);
    const fallbackName = String(parsed.slug)
      .split("-")
      .filter(Boolean)
      .map((word) => word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1))
      .join(" ");
    const meta = {
      id,
      type: category.type,
      name: fallbackName,
      poster: config.defaultPoster,
      posterShape: "poster",
      background: config.defaultPoster,
      description: \`Assista \${fallbackName} no NoveFlix.\`,
      genres: [category.genre]
    };
    if (category.episodic) meta.videos = [];
    return { meta };
  }
});`;

  if (!source.includes(oldMetaCatch)) {
    throw new Error("Patch 4.2.2: tratamento de erro do metadata não encontrado.");
  }
  source = source.replace(oldMetaCatch, newMetaCatch);

  source = source.replaceAll("4.2.0", "4.2.2");
  return source;
};

try {
  require("./index-v421.js");
} finally {
  fs.readFileSync = originalReadFileSync;
}
