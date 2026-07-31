module.exports = {
  port: Number(process.env.PORT || 7000),

  show: {
    id: "noveflix:qac",
    type: "series",
    name: "Quem Ama Cuida",
    description: "Episódios de Quem Ama Cuida no NoveFlix.",
    poster: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
    background: "https://painel1.novefx.biz/uploads/banners/QAC/QAC-063_thumb.jpg",
    genres: ["Novela"],
    releaseInfo: "2026",

    // Primeiro episódio que você deseja exibir no Stremio.
    firstEpisode: 1,

    // Último confirmado. O addon verificará automaticamente 64, 65, 66...
    knownLatestEpisode: 63,

    // Evita sondagem infinita em caso de resposta inesperada do CDN.
    maxEpisode: 999,

    season: 1,
    code: "QAC",
    folder: "QAC",
    storage: "storage1",
    cdnBase: "https://23rzv4udpdbv8t6.cdn-novflix.com",

    // Cache da descoberta do episódio mais recente.
    latestCacheMinutes: 10
  }
};
