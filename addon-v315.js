"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const sourcePath = path.join(__dirname, "addon-v314.js");
let source = fs.readFileSync(sourcePath, "utf8");

// Quem Ama Cuida também não expõe o player no HTML recebido pelo Render.
// Aplicamos o padrão já confirmado anteriormente no próprio site.
source = source.replace(
  'if (!media && categoryKey === "novelas" && slug === "a-escrava-isaura") {',
  'if (!media && categoryKey === "novelas" && slug === "quem-ama-cuida") {\n      media = "https://23rzv4udpdbv8t6.cdn-novflix.com/storage1/QAC/QAC-063.mp4";\n      console.log("Fallback aplicado: Quem Ama Cuida -> QAC-063");\n    }\n    if (!media && categoryKey === "novelas" && slug === "a-escrava-isaura") {'
);

source = source.replace(
  'id:"com.noveflix.catalog.fusion",version:"3.1.4"',
  'id:"com.noveflix.catalog.fusion",version:"3.1.5"'
);
source = source.replaceAll("NoveFlix 3.1.4", "NoveFlix 3.1.5");

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
