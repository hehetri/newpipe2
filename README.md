# NoveFlix — addon para Stremio

Esta primeira versão adiciona **Quem Ama Cuida** como série e gera os links dos episódios usando o padrão:

`https://23rzv4udpdbv8t6.cdn-novflix.com/storage1/QAC/QAC-063.mp4`

Use apenas com conteúdo que você possui ou está autorizado a distribuir.

## Testar no computador

Instale o Node.js 18 ou superior. Abra o terminal dentro desta pasta e execute:

```bash
npm install
npm start
```

Depois, no Stremio, instale:

```text
http://127.0.0.1:7000/manifest.json
```

## Configurar episódios

Edite `config.js`:

- `firstEpisode`: primeiro episódio exibido;
- `knownLatestEpisode`: último episódio já confirmado;
- `code` e `folder`: neste caso, `QAC`;
- `cdnBase`: domínio do CDN;
- `latestCacheMinutes`: intervalo para testar episódios novos.

Quando o episódio 64 existir, o addon testa a URL `QAC-064.mp4` e passa a exibi-lo automaticamente. Depois testa 65, e assim por diante.

## Colocar online

O endereço remoto precisa usar HTTPS. Você pode hospedar esta pasta em um servidor Node.js, Railway, Render, VPS ou outro serviço compatível. Configure o comando de inicialização como:

```bash
npm start
```

A URL de instalação será parecida com:

```text
https://seu-addon.exemplo.com/manifest.json
```

## Observação sobre o primeiro episódio

O HAR enviado confirma diretamente o episódio 63. A existência dos episódios anteriores e posteriores depende das URLs do CDN. Ajuste `firstEpisode` caso a numeração real não comece em 1.
