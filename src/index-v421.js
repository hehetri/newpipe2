"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const sourcePath = path.join(__dirname, "index.js");
let source = fs.readFileSync(sourcePath, "utf8");

const oldCardImage = `function cardImage($, anchor, base) {
  const image = $(anchor).find("img").first();
  return absoluteUrl(
    image.attr("data-src") || image.attr("data-lazy-src") ||
    image.attr("data-original") || image.attr("src"),
    base
  );
}`;

const newCardImage = `function srcsetCandidate(value) {
  if (!value) return null;
  const entries = String(value).split(",").map((entry) => {
    const parts = entry.trim().split(/\\s+/);
    const descriptor = parts[1] || "0w";
    const size = Number.parseFloat(descriptor) || 0;
    return { url: parts[0], size };
  }).filter((entry) => entry.url);
  entries.sort((a, b) => b.size - a.size);
  return entries[0]?.url || null;
}

function backgroundImage(value) {
  const match = String(value || "").match(/url\\(\\s*['\"]?([^'\")]+)['\"]?\\s*\\)/i);
  return match?.[1] || null;
}

function usableImage(value, base) {
  const url = absoluteUrl(value, base);
  if (!url || /^data:/i.test(url)) return null;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\\/(?:favicon|logo|avatar|spinner|loader)(?:[-_.\\/]|$)/i.test(pathname)) return null;
    if (/(?:placeholder|no-image|sem-imagem|blank\\.(?:gif|png|jpg|webp)$)/i.test(pathname)) return null;
  } catch {}
  return url;
}

function imageFromNode($, node, base) {
  if (!node || !node.length) return null;
  const attributes = [
    "data-lazy-src", "data-src", "data-original", "data-image",
    "data-lazy", "data-url", "src"
  ];
  for (const attribute of attributes) {
    const image = usableImage(node.attr(attribute), base);
    if (image) return image;
  }
  for (const attribute of ["data-srcset", "srcset"]) {
    const image = usableImage(srcsetCandidate(node.attr(attribute)), base);
    if (image) return image;
  }
  return usableImage(backgroundImage(node.attr("style")), base);
}

function cardImage($, anchor, base) {
  const link = $(anchor);
  const scopes = [
    link,
    link.closest("article,.post,.item,.card,.poster,.movie,.serie,.novela,.video,.entry,.elementor-widget,.jet-listing-grid__item")
  ];
  const selectors = [
    "img.wp-post-image", "img.attachment-post-thumbnail", "picture img",
    "img[data-lazy-src]", "img[data-src]", "img[data-original]", "img",
    "picture source[srcset]", "source[data-srcset]", "[style*='background-image']"
  ];
  for (const scope of scopes) {
    const own = imageFromNode($, scope, base);
    if (own) return own;
    for (const selector of selectors) {
      const nodes = scope.find(selector);
      for (let index = 0; index < nodes.length; index += 1) {
        const image = imageFromNode($, nodes.eq(index), base);
        if (image) return image;
      }
    }
  }
  return null;
}

function jsonLdImage($, base) {
  const images = [];
  $("script[type='application/ld+json']").each((_, script) => {
    try {
      const parsed = JSON.parse($(script).text());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== "object") continue;
        for (const key of ["image", "thumbnailUrl", "contentUrl"]) {
          const candidate = value[key];
          if (typeof candidate === "string") images.push(candidate);
          else if (Array.isArray(candidate)) queue.push(...candidate);
          else if (candidate && typeof candidate === "object") queue.push(candidate);
        }
        if (Array.isArray(value["@graph"])) queue.push(...value["@graph"]);
        if (typeof value.url === "string" && /\\.(?:jpe?g|png|webp|avif)(?:\\?|$)/i.test(value.url)) images.push(value.url);
      }
    } catch {}
  });
  for (const value of images) {
    const image = usableImage(value, base);
    if (image) return image;
  }
  return null;
}

function pagePoster($, base) {
  const metaSelectors = [
    "meta[property='og:image:secure_url']", "meta[property='og:image']",
    "meta[name='twitter:image:src']", "meta[name='twitter:image']",
    "link[rel='image_src']", "meta[itemprop='image']"
  ];
  for (const selector of metaSelectors) {
    const node = $(selector).first();
    const image = usableImage(node.attr("content") || node.attr("href"), base);
    if (image) return image;
  }
  const structured = jsonLdImage($, base);
  if (structured) return structured;
  const selectors = [
    "img.wp-post-image", ".post-thumbnail img", ".entry-thumbnail img",
    ".featured-image img", "article picture img", "article img",
    ".entry-content img", "main img", "[style*='background-image']"
  ];
  for (const selector of selectors) {
    const nodes = $(selector);
    for (let index = 0; index < nodes.length; index += 1) {
      const image = imageFromNode($, nodes.eq(index), base);
      if (image) return image;
    }
  }
  return null;
}`;

if (!source.includes(oldCardImage)) {
  throw new Error("Não foi possível aplicar a atualização de capas: cardImage não encontrado.");
}
source = source.replace(oldCardImage, newCardImage);

const oldPosterLine = `poster: absoluteUrl(metaValue($, ["meta[property='og:image']", "meta[name='twitter:image']", "link[rel='image_src']"]) || base.poster, response.finalUrl),`;
const newPosterLine = `poster: pagePoster($, response.finalUrl) || base.poster,`;
if (!source.includes(oldPosterLine)) {
  throw new Error("Não foi possível aplicar a atualização de capas: campo poster não encontrado.");
}
source = source.replace(oldPosterLine, newPosterLine);

source = source.replace('id: "com.noveflix.addononly.v42",\n  version: "4.2.0"', 'id: "com.noveflix.addononly.v42",\n  version: "4.2.1"');
source = source.replaceAll("NoveFlix 4.2.0", "NoveFlix 4.2.1");

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
