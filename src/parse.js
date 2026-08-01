"use strict";

const config = require("./config");

const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();

function absoluteUrl(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(String(value).trim(), base).href; } catch { return null; }
}

function pathSegments(value) {
  try { return new URL(value).pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
  catch { return []; }
}

function slugFromUrl(value) {
  const segments = pathSegments(value);
  return (segments.at(-1) || "").toLowerCase();
}

function sameHost(value, base = config.siteBase) {
  try { return new URL(value).hostname.replace(/^www\./i, "") === new URL(base).hostname.replace(/^www\./i, ""); }
  catch { return false; }
}

// Segmentos que nunca são conteúdo (arquivos, sistema, páginas institucionais).
const DENY_SEGMENTS = new Set([
  "categoria", "category", "categorias", "tag", "tags", "autor", "author", "page", "pagina",
  "wp-admin", "wp-json", "wp-content", "wp-includes", "wp-login.php", "feed", "comments",
  "login", "entrar", "logout", "sair", "cadastro", "registrar", "registro", "conta",
  "minha-conta", "checkout", "carrinho", "planos", "assinatura", "assinar", "contato",
  "sobre", "quem-somos", "dmca", "termos", "privacidade", "politica-de-privacidade",
  "busca", "search", "?s", "amp", "cdn-cgi", "xmlrpc.php", "sitemap.xml"
]);

const CONTENT_PREFIX = new RegExp(
  `^(?:${config.contentPathPrefixes.join("|")}|assistir-[^/]+)$`, "i"
);

/** URL de um item do catálogo no padrão canônico do site (/assista/slug/). */
function isContentUrl(value, base = config.siteBase) {
  if (!sameHost(value, base)) return false;
  const segments = pathSegments(value);
  if (segments.length < 2) return false;
  if (!CONTENT_PREFIX.test(segments[0])) return false;
  const slug = segments.at(-1).toLowerCase();
  return Boolean(slug) && !DENY_SEGMENTS.has(slug) && !/\.\w{2,5}$/.test(slug);
}

/**
 * Heurística usada quando o padrão canônico não encontra nada — o tema do
 * WordPress pode publicar os posts em qualquer permalink. Aceita links rasos,
 * do mesmo domínio, que não sejam páginas de sistema.
 */
function looksLikePost(value, base = config.siteBase) {
  if (!sameHost(value, base)) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.search || parsed.hash) return false;
  const segments = pathSegments(value);
  if (!segments.length || segments.length > 3) return false;
  if (segments.some((segment) => DENY_SEGMENTS.has(segment.toLowerCase()))) return false;
  if (segments.some((segment) => /^\d{1,4}$/.test(segment) && segments.length > 2)) return false;
  const slug = segments.at(-1).toLowerCase();
  if (/\.\w{2,5}$/.test(slug)) return false;
  return slug.length >= 4;
}

function srcsetCandidate(value) {
  if (!value) return null;
  const entries = String(value).split(",").map((entry) => {
    const parts = entry.trim().split(/\s+/);
    return { url: parts[0], size: Number.parseFloat(parts[1] || "0") || 0 };
  }).filter((entry) => entry.url);
  entries.sort((a, b) => b.size - a.size);
  return entries[0]?.url || null;
}

function backgroundImage(value) {
  const match = String(value || "").match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return match?.[1] || null;
}

function usableImage(value, base) {
  const url = absoluteUrl(value, base);
  if (!url || /^data:/i.test(url)) return null;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\/(?:favicon|logo|avatar|spinner|loader)(?:[-_./]|$)/i.test(pathname)) return null;
    if (/(?:placeholder|no-image|sem-imagem|blank\.(?:gif|png|jpg|webp)$)/i.test(pathname)) return null;
  } catch {}
  return url;
}

function imageFromNode($, node, base) {
  if (!node || !node.length) return null;
  const attributes = ["data-lazy-src", "data-src", "data-original", "data-image", "data-lazy", "data-url", "src"];
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

const CARD_SELECTOR =
  "article,.post,.item,.card,.poster,.movie,.serie,.novela,.video,.entry,.elementor-widget,.jet-listing-grid__item,li";

const IMAGE_SELECTORS = [
  "img.wp-post-image", "img.attachment-post-thumbnail", "picture img",
  "img[data-lazy-src]", "img[data-src]", "img[data-original]", "img",
  "picture source[srcset]", "source[data-srcset]", "[style*='background-image']"
];

/** Capa exibida no card do arquivo da categoria. */
function cardImage($, anchor, base) {
  const link = $(anchor);
  const scopes = [link, link.closest(CARD_SELECTOR)];
  for (const scope of scopes) {
    const own = imageFromNode($, scope, base);
    if (own) return own;
    for (const selector of IMAGE_SELECTORS) {
      const nodes = scope.find(selector);
      for (let index = 0; index < nodes.length; index += 1) {
        const image = imageFromNode($, nodes.eq(index), base);
        if (image) return image;
      }
    }
  }
  return null;
}

function cardTitle($, anchor, slug) {
  const node = $(anchor);
  const image = node.find("img").first();
  const card = node.closest(CARD_SELECTOR);
  const fromCard = card.length
    ? card.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text()
    : "";
  return clean(
    node.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() ||
    image.attr("alt") || image.attr("title") || node.attr("title") ||
    fromCard || node.text() || titleFromSlug(slug)
  ).slice(0, 160) || titleFromSlug(slug);
}

function titleFromSlug(slug) {
  return String(slug || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 && /^(?:de|da|do|e|a|o)$/i.test(word)
      ? word.toLocaleLowerCase("pt-BR")
      : word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1)))
    .join(" ") || "NoveFlix";
}

function metaValue($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = node.attr("content") || node.attr("href") || node.attr("src");
    if (value) return clean(value);
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
        if (typeof value.url === "string" && /\.(?:jpe?g|png|webp|avif)(?:\?|$)/i.test(value.url)) images.push(value.url);
      }
    } catch {}
  });
  for (const value of images) {
    const image = usableImage(value, base);
    if (image) return image;
  }
  return null;
}

/** Capa real da página do conteúdo (og:image, JSON-LD ou destaque do post). */
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
}

function cleanTitle(title) {
  return clean(title)
    .replace(/^Assistir?\s+/i, "")
    .replace(/\s+Online(?:\s+Gr[áa]tis)?(?:\s+HD)?$/i, "")
    .replace(/\s*[|–-]\s*NoveFlix.*$/i, "")
    .trim();
}

module.exports = {
  clean, absoluteUrl, slugFromUrl, sameHost, pathSegments,
  isContentUrl, looksLikePost, cardImage, cardTitle, titleFromSlug,
  metaValue, pagePoster, cleanTitle, imageFromNode, usableImage
};
