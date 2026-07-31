"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const sourcePath = path.join(__dirname, "addon-v311.js");
let source = fs.readFileSync(sourcePath, "utf8");

// O HAR confirmou o player e o MP4 de A Escrava Isaura. A página pública
// não entrega esse link no HTML recebido pelo servidor do Render, então
// usamos o padrão confirmado como fallback, mantendo o extrator automático
// para todos os demais conteúdos.
source = source.replace(
  "let media = directMedia(page.text,page.finalUrl);",
  `let media = directMedia(page.text,page.finalUrl);\n    if (!media && categoryKey === "novelas" && slug === "a-escrava-isaura") {\n      media = "https://23rzv4udpdbv8t6.cdn-novflix.com/storage6/ESC/ESC-167.mp4";\n      console.log("Fallback HAR aplicado: A Escrava Isaura -> ESC-167");\n    }`
);

source = source.replaceAll("3.1.1", "3.1.2");

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
