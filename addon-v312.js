"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const sourcePath = path.join(__dirname, "addon-v311.js");
let source = fs.readFileSync(sourcePath, "utf8");

// Fallback confirmado pelo HAR de A Escrava Isaura.
source = source.replace(
  "let media = directMedia(page.text,page.finalUrl);",
  `let media = directMedia(page.text,page.finalUrl);\n    if (!media && categoryKey === "novelas" && slug === "a-escrava-isaura") {\n      media = "https://23rzv4udpdbv8t6.cdn-novflix.com/storage6/ESC/ESC-167.mp4";\n      console.log("Fallback HAR aplicado: A Escrava Isaura -> ESC-167");\n    }`
);

// Novo ID força Fusion/Stremio a não reutilizar metadados em cache do addon antigo.
source = source.replace(
  'id:"com.noveflix.catalog",version:"3.1.1"',
  'id:"com.noveflix.catalog.v2",version:"3.1.3"'
);
source = source.replaceAll("NoveFlix 3.1.1", "NoveFlix 3.1.3");

// Inclui data nos episódios para compatibilidade com clientes mais rígidos.
source = source.replace(
  'title:`Episódio ${i+1}`,season:1,episode:i+1',
  'title:`Episódio ${i+1}`,season:1,episode:i+1,released:new Date(Date.UTC(2023,0,1+i)).toISOString()'
);

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
