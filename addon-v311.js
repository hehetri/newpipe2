"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const cheerio = require("cheerio");
const config = require("./config");

const catalogCache = new Map();
const detailCache = new Map();
const clean = (v = "") => String(v).replace(/\s+/g, " ").trim();
const pad = (n) => String(n).padStart(3, "0");

function abs(value, base = config.siteBase) {
  if (!value) return null;
  try { return new URL(value, base).href; } catch { return null; }
}
function isContentUrl(value) {
  try { return /\/(?:assista|assistir)(?:\/|$)/i.test(new URL(value).pathname); } catch { return false; }
}
function slugFromUrl(value) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const marker = Math.max(parts.indexOf("assista"), parts.indexOf("assistir"));
    return decodeURIComponent((marker >= 0 ? parts.slice(marker + 1).at(-1) : parts.at(-1)) || "").toLowerCase();
  } catch { return ""; }
}
function contentId(category, slug) { return `noveflix:${category}:${slug}`; }
function episodeId(item, episode) { return `${item.id}:1:${episode}`; }
function parseId(id) {
  const p = String(id).split(":");
  return p[0] === "noveflix" && p.length >= 3 ? { category: p[1], slug: p[2], episode: Number(p[4]) } : null;
}
function categoryByKey(key) { return config.categories.find((x) => x.key === key) || null; }

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeout || config.requestTimeoutMs),
    headers: {
      "user-agent": config.userAgent,
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return { text: await response.text(), finalUrl: response.url };
}

function metaValue($, selectors) {
  for (const selector of selectors) {
    const n = $(selector).first();
    const v = n.attr("content") || n.attr("href") || n.attr("src");
    if (v) return clean(v);
  }
  return null;
}
function cardTitle($, anchor, slug) {
  const n = $(anchor), img = n.find("img").first();
  return clean(img.attr("alt") || img.attr("title") || n.attr("title") || n.find("h1,h2,h3,h4,h5,.title,.titulo,.entry-title,.post-title").first().text() || n.text() || slug.replace(/-/g, " "));
}
function cardImage($, anchor, base) {
  const img = $(anchor).find("img").first();
  return abs(img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("src"), base);
}

async function scrapeCategory(category, force = false) {
  const cached = catalogCache.get(category.key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;
  const found = new Map();
  for (let page = 1; page <= config.maxCatalogPages; page++) {
    const url = page === 1 ? category.url : `${category.url.replace(/\/$/, "")}/page/${page}/`;
    let response;
    try { response = await fetchText(url); } catch (e) { if (page === 1) console.error(e.message); break; }
    const $ = cheerio.load(response.text);
    let added = 0;
    $("a[href]").each((_, a) => {
      const pageUrl = abs($(a).attr("href"), response.finalUrl);
      if (!pageUrl || !isContentUrl(pageUrl)) return;
      const slug = slugFromUrl(pageUrl);
      if (!slug || config.ignoredSlugs.includes(slug)) return;
      const prev = found.get(slug), name = cardTitle($, a, slug), image = cardImage($, a, response.finalUrl);
      found.set(slug, {
        id: contentId(category.key, slug), category: category.key, slug, pageUrl,
        type: category.type, episodic: category.episodic,
        name: prev?.name && prev.name.length > name.length ? prev.name : name,
        poster: prev?.poster || image, background: prev?.background || image,
        description: prev?.description || `Assista ${name} no NoveFlix.`, genres: [category.genre]
      });
      if (!prev) added++;
    });
    if (!added) break;
  }
  for (const f of config.fallbackShows.filter((x) => x.category === category.key)) {
    if (!found.has(f.slug)) found.set(f.slug, { ...f, id: contentId(category.key, f.slug), genres: [f.genre || category.genre] });
  }
  const value = [...found.values()].sort((a,b) => a.name.localeCompare(b.name,"pt-BR"));
  catalogCache.set(category.key, { value, expiresAt: Date.now() + config.catalogCacheMinutes * 60000 });
  console.log(`${category.name}: ${value.length} itens.`);
  return value;
}

function tryDecodeBase64(value) {
  try {
    const normalized = decodeURIComponent(value).replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
    const json = JSON.parse(decoded);
    return json.safelink || json.second_safelink_url || null;
  } catch { return null; }
}
function decodeSafeLink(raw) {
  try {
    const u = new URL(raw);
    const directQuery = u.search.length > 1 && !u.search.slice(1).includes("=") ? tryDecodeBase64(u.search.slice(1)) : null;
    if (directQuery) return directQuery;
    for (const [key, value] of u.searchParams) {
      if (/safelink|redirect/i.test(key)) {
        const decoded = tryDecodeBase64(value);
        if (decoded) return decoded;
      }
    }
  } catch {}
  return raw;
}
function extractUrls(html, base) {
  const urls = new Set();
  const add = (v) => {
    if (!v) return;
    const url = abs(v.replace(/\\\//g, "/").replace(/&amp;/g, "&"), base);
    if (url) { urls.add(url); const d = decodeSafeLink(url); if (d !== url) urls.add(d); }
  };
  const $ = cheerio.load(html);
  $("[href],[src],[data-src],[data-url],[onclick]").each((_, el) => {
    for (const attr of ["href","src","data-src","data-url"]) add($(el).attr(attr));
    const onclick = $(el).attr("onclick") || "";
    for (const m of onclick.match(/https?:[^'"\s)]+/g) || []) add(m);
  });
  for (const m of html.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || []) add(m);
  for (const token of html.match(/[A-Za-z0-9+/_-]{24,}={0,2}/g) || []) {
    const decoded = tryDecodeBase64(token);
    if (decoded) add(decoded);
  }
  return [...urls];
}
function directMedia(html, base) {
  const regexes = [
    /(?:file|src|url)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi,
    /["'](https?:\\?\/\\?\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/gi
  ];
  for (const re of regexes) {
    let m; while ((m = re.exec(html))) { const u = abs(m[1].replace(/\\\//g,"/").replace(/&amp;/g,"&"), base); if (u) return u; }
  }
  return null;
}
async function resolveMedia(rawUrl, depth = 0) {
  if (!rawUrl || depth > 5) return null;
  const url = decodeSafeLink(rawUrl);
  if (/\.(mp4|m3u8)(\?|$)/i.test(url)) return url;
  try {
    const page = await fetchText(url);
    const direct = directMedia(page.text, page.finalUrl);
    if (direct) return direct;
    const candidates = extractUrls(page.text, page.finalUrl).filter((u) => /novefx\.biz\/v\//i.test(u) || /esportesdavez\.com/i.test(u) || /\.(mp4|m3u8)(\?|$)/i.test(u));
    for (const candidate of candidates) {
      const result = await resolveMedia(candidate, depth + 1);
      if (result) return result;
    }
  } catch (e) { console.warn(`Falha ao resolver ${url}: ${e.message}`); }
  return null;
}
function mediaPattern(url) {
  try {
    const u = new URL(url), m = u.pathname.match(/^(.*\/)([^/]+)-(\d+)\.(mp4|m3u8)$/i);
    return m ? { basePath: `${u.origin}${m[1]}`, code: m[2], currentEpisode: Number(m[3]), extension: m[4].toLowerCase() } : null;
  } catch { return null; }
}
function episodeUrl(p, ep) { return `${p.basePath}${p.code}-${pad(ep)}.${p.extension}`; }
async function urlExists(url) {
  try {
    let r = await fetch(url, { method:"HEAD", redirect:"follow", signal:AbortSignal.timeout(config.mediaCheckTimeoutMs), headers:{"user-agent":config.userAgent} });
    if (r.ok) return true;
    if ([403,405,501].includes(r.status)) {
      r = await fetch(url, { method:"GET", redirect:"follow", signal:AbortSignal.timeout(config.mediaCheckTimeoutMs), headers:{"user-agent":config.userAgent,Range:"bytes=0-0"} });
      return r.ok || r.status === 206;
    }
  } catch {}
  return false;
}
async function latestEpisode(pattern) {
  let latest = Math.max(1, pattern.currentEpisode || 1);
  for (let n = latest + 1; n <= latest + config.maxFutureEpisodeChecks; n++) {
    if (!(await urlExists(episodeUrl(pattern,n)))) break;
    latest = n;
  }
  return latest;
}

async function details(categoryKey, slug, force = false) {
  const cacheKey = `${categoryKey}:${slug}`, cached = detailCache.get(cacheKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.value;
  const category = categoryByKey(categoryKey), catalog = await scrapeCategory(category), base = catalog.find((x) => x.slug === slug);
  if (!base) throw new Error(`Conteúdo não encontrado: ${cacheKey}`);
  let value = { ...base, mediaUrl:null, pattern:null, latestEpisode:null };
  try {
    const page = await fetchText(base.pageUrl), $ = cheerio.load(page.text);
    let name = clean(metaValue($,["meta[property='og:title']","meta[name='twitter:title']"]) || $("h1").first().text() || base.name)
      .replace(/^Assistir\s+/i, "").replace(/\s+Online(?:\s+Grátis)?(?:\s+HD)?$/i, "").replace(/\s*[|–-]\s*NoveFlix.*$/i, "");
    const description = clean(metaValue($,["meta[property='og:description']","meta[name='description']"]) || $(".sinopse,.synopsis,.description,.entry-content p").first().text() || base.description);
    const poster = abs(metaValue($,["meta[property='og:image']","meta[name='twitter:image']","link[rel='image_src']"]) || base.poster,page.finalUrl);
    value = { ...value, name, description, poster, background:poster, releaseInfo: clean(page.text).match(/(?:19|20)\d{2}/)?.[0] };
    let media = directMedia(page.text,page.finalUrl);
    if (!media) {
      const candidates = extractUrls(page.text,page.finalUrl).filter((u) => /novefx\.biz\/v\//i.test(u) || /esportesdavez\.com/i.test(u) || /\.(mp4|m3u8)(\?|$)/i.test(u));
      console.log(`Candidatos de player para ${name}: ${candidates.slice(0,5).join(" | ")}`);
      for (const c of candidates.slice(0,config.maxPlayerCandidates)) { media = await resolveMedia(c); if (media) break; }
    }
    if (media) {
      value.mediaUrl = media; value.pattern = category.episodic ? mediaPattern(media) : null;
      value.latestEpisode = value.pattern ? await latestEpisode(value.pattern) : null;
      console.log(`Player localizado: ${name} -> ${media}`);
    } else console.warn(`Player ainda não localizado para ${name}.`);
  } catch (e) { console.warn(`Detalhes parciais para ${base.name}: ${e.message}`); }
  detailCache.set(cacheKey,{value,expiresAt:Date.now()+config.showCacheMinutes*60000});
  return value;
}
function toMeta(x) { return { id:x.id,type:x.type,name:x.name,poster:x.poster||config.defaultPoster,posterShape:"poster",background:x.background||x.poster||config.defaultBackground,description:x.description||`Assista ${x.name} no NoveFlix.`,genres:x.genres||[],releaseInfo:x.releaseInfo }; }
function videos(x) { return x.episodic && x.pattern && x.latestEpisode ? Array.from({length:x.latestEpisode},(_,i)=>({id:episodeId(x,i+1),title:`Episódio ${i+1}`,season:1,episode:i+1})) : []; }

const manifest = {
  id:"com.noveflix.catalog",version:"3.1.1",name:"NoveFlix",description:"Catálogo automático do NoveFlix",
  logo:config.defaultPoster,background:config.defaultBackground,resources:["catalog","meta","stream"],types:["movie","series"],idPrefixes:["noveflix:"],
  behaviorHints:{configurable:false,configurationRequired:false,newEpisodeNotifications:true},
  catalogs:config.categories.map(c=>({type:c.type,id:`noveflix-${c.key}`,name:c.name,pageSize:config.pageSize,extra:[{name:"search",isRequired:false},{name:"skip",isRequired:false}]}))
};
const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(async ({type,id,extra={}}) => {
  const c=config.categories.find(x=>`noveflix-${x.key}`===id&&x.type===type); if(!c)return{metas:[]};
  let items=await scrapeCategory(c); const q=clean(extra.search).toLowerCase(); if(q)items=items.filter(x=>x.name.toLowerCase().includes(q)); const skip=Math.max(0,parseInt(extra.skip||0)||0); return{metas:items.slice(skip,skip+config.pageSize).map(toMeta)};
});
builder.defineMetaHandler(async ({type,id}) => {
  const p=parseId(id),c=p&&categoryByKey(p.category); if(!p||!c||c.type!==type)return{meta:null};
  try { const item=await details(p.category,p.slug); const meta=toMeta(item); if(item.episodic)meta.videos=videos(item); console.log(`Meta entregue: ${id} (${meta.videos?.length||0} episódios)`); return{meta}; } catch(e){console.error(e);return{meta:null};}
});
builder.defineStreamHandler(async ({type,id}) => {
  const p=parseId(id),c=p&&categoryByKey(p.category); if(!p||!c||c.type!==type)return{streams:[]};
  const item=await details(p.category,p.slug); if(!item.episodic)return item.mediaUrl?{streams:[{name:"NoveFlix",title:item.name,url:item.mediaUrl}]}:{streams:[]};
  if(!item.pattern||!Number.isInteger(p.episode)||p.episode<1||p.episode>item.latestEpisode)return{streams:[]};
  return{streams:[{name:"NoveFlix",title:`${item.name} — Episódio ${p.episode}`,url:episodeUrl(item.pattern,p.episode),behaviorHints:{bingeGroup:`${item.id}:season:1`}}]};
});
serveHTTP(builder.getInterface(),{port:config.port});
console.log(`NoveFlix 3.1.1 iniciado em http://127.0.0.1:${config.port}/manifest.json`);
