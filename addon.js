"use strict";

const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const config = require("./config");

const show = config.show;
let latestCache = {
  value: show.knownLatestEpisode,
  checkedAt: 0
};

function padEpisode(number) {
  return String(number).padStart(3, "0");
}

function episodeUrl(number) {
  const ep = padEpisode(number);
  return `${show.cdnBase}/${show.storage}/${show.folder}/${show.code}-${ep}.mp4`;
}

function episodeId(number) {
  return `${show.id}:${show.season}:${number}`;
}

async function urlExists(url) {
  try {
    let response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(7000)
    });

    if (response.ok) return true;

    if ([403, 405, 501].includes(response.status)) {
      response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(7000)
      });
      return response.ok || response.status === 206;
    }

    return false;
  } catch (error) {
    console.warn(`Falha ao verificar ${url}: ${error.message}`);
    return false;
  }
}

async function discoverLatestEpisode() {
  const cacheMs = show.latestCacheMinutes * 60 * 1000;
  if (Date.now() - latestCache.checkedAt < cacheMs) {
    return latestCache.value;
  }

  let latest = Math.max(latestCache.value, show.knownLatestEpisode);

  for (let candidate = latest + 1; candidate <= show.maxEpisode; candidate += 1) {
    const exists = await urlExists(episodeUrl(candidate));
    if (!exists) break;
    latest = candidate;
  }

  latestCache = { value: latest, checkedAt: Date.now() };
  console.log(`Último episódio detectado: ${latest}`);
  return latest;
}

function buildVideos(latest) {
  const videos = [];
  for (let episode = show.firstEpisode; episode <= latest; episode += 1) {
    videos.push({
      id: episodeId(episode),
      title: `Episódio ${episode}`,
      season: show.season,
      episode,
      released: new Date().toISOString()
    });
  }
  return videos;
}

function catalogMeta() {
  return {
    id: show.id,
    type: show.type,
    name: show.name,
    poster: show.poster,
    posterShape: "poster",
    background: show.background,
    description: show.description,
    genres: show.genres,
    releaseInfo: show.releaseInfo
  };
}

const manifest = {
  id: "com.noveflix.catalog",
  version: "1.0.1",
  name: "NoveFlix",
  description: "Catálogo autorizado do NoveFlix",
  logo: show.poster,
  background: show.background,
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: ["noveflix:"],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
    newEpisodeNotifications: true
  },
  catalogs: [
    {
      type: "series",
      id: "noveflix-series",
      name: "NoveFlix",
      pageSize: 50,
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ]
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  if (type !== "series" || id !== "noveflix-series") return { metas: [] };

  let metas = [catalogMeta()];

  const search = String(extra.search || "").trim().toLowerCase();
  if (search) {
    metas = metas.filter((item) =>
      item.name.toLowerCase().includes(search) ||
      item.description.toLowerCase().includes(search)
    );
  }

  const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
  return { metas: metas.slice(skip, skip + 50) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "series" || id !== show.id) return { meta: null };

  const latest = await discoverLatestEpisode();
  return {
    meta: {
      ...catalogMeta(),
      videos: buildVideos(latest)
    }
  };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "series" || !id.startsWith(`${show.id}:`)) return { streams: [] };

  const parts = id.split(":");
  const episode = Number(parts.at(-1));
  if (!Number.isInteger(episode) || episode < show.firstEpisode || episode > show.maxEpisode) {
    return { streams: [] };
  }

  return {
    streams: [
      {
        name: "NoveFlix",
        title: `${show.name} — Episódio ${episode}`,
        url: episodeUrl(episode),
        behaviorHints: {
          bingeGroup: `${show.id}:season:${show.season}`
        }
      }
    ]
  };
});

serveHTTP(builder.getInterface(), { port: config.port });
console.log(`Addon iniciado em http://127.0.0.1:${config.port}/manifest.json`);
