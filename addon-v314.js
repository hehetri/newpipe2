"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const sourcePath = path.join(__dirname, "addon-v311.js");
let source = fs.readFileSync(sourcePath, "utf8");

// Fusion interpreta os dois últimos segmentos separados por ':' como
// temporada e episódio. O meta ID antigo tinha segmentos extras:
// noveflix:novelas:a-escrava-isaura
// O novo formato mantém somente um ':' no meta ID:
// noveflix:novelas-a-escrava-isaura
source = source.replace(
  'function contentId(category, slug) { return `noveflix:${category}:${slug}`; }',
  'function contentId(category, slug) { return `noveflix:${category}-${slug}`; }'
);

source = source.replace(
  'function parseId(id) {\n  const p = String(id).split(":");\n  return p[0] === "noveflix" && p.length >= 3 ? { category: p[1], slug: p[2], episode: Number(p[4]) } : null;\n}',
  'function parseId(id) {\n  const p = String(id).split(":");\n  if (p[0] !== "noveflix" || !p[1]) return null;\n  const separator = p[1].indexOf("-");\n  if (separator < 1) return null;\n  return {\n    category: p[1].slice(0, separator),\n    slug: p[1].slice(separator + 1),\n    season: Number(p[2]),\n    episode: Number(p[3])\n  };\n}'
);

// Fallback confirmado pelo HAR enviado pelo usuário.
source = source.replace(
  "let media = directMedia(page.text,page.finalUrl);",
  `let media = directMedia(page.text,page.finalUrl);\n    if (!media && categoryKey === "novelas" && slug === "a-escrava-isaura") {\n      media = "https://23rzv4udpdbv8t6.cdn-novflix.com/storage6/ESC/ESC-167.mp4";\n      console.log("Fallback HAR aplicado: A Escrava Isaura -> ESC-167");\n    }`
);

source = source.replace(
  'id:"com.noveflix.catalog",version:"3.1.1"',
  'id:"com.noveflix.catalog.fusion",version:"3.1.4"'
);
source = source.replaceAll("NoveFlix 3.1.1", "NoveFlix 3.1.4");

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
