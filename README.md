# NoveFlix Stremio 4.0

Esta versão elimina os patches por título (`QAC`, `ESC` etc.). O catálogo e os players são lidos diretamente do WordPress do NoveFlix por um plugin-ponte. O addon continua hospedado no Render.

## 1. Instalar o plugin no WordPress

Arquivo: `noveflix-stremio-bridge.zip`

No WordPress:

1. Plugins → Adicionar novo → Enviar plugin.
2. Instale e ative o ZIP.
3. Abra Configurações → NoveFlix Stremio.
4. O token é opcional. Deixe vazio para funcionar sem configurar segredo no Render.

O plugin lê posts públicos, categorias, imagens, conteúdo, campos personalizados e tabelas de player/stream/episode/video ligadas ao post. Ele identifica URLs diretas, SafeLinks/Base64 e links `painelN.novefx.biz/v/CODIGO123`.

## 2. Configurar o Render

Quando o plugin estiver no domínio padrão atual, basta fazer novo deploy. Para informar outro domínio, adicione:

```text
NOVEFLIX_BRIDGE_URL=https://SEU-DOMINIO/wp-json/noveflix-stremio/v1
```

Quando preencher um token no WordPress, adicione também:

```text
NOVEFLIX_BRIDGE_TOKEN=O_MESMO_TOKEN
```

Build command:

```text
npm install
```

Start command:

```text
npm start
```

## 3. Instalar no Stremio/Fusion

```text
https://newpipe2.onrender.com/manifest.json
```

## Endpoints de teste

```text
https://SEU-DOMINIO/wp-json/noveflix-stremio/v1/health
https://SEU-DOMINIO/wp-json/noveflix-stremio/v1/catalog?category=novelas&page=1&per_page=5
```

O novo formato de ID é baseado no ID real do post do WordPress:

```text
noveflix:novelas-1234
noveflix:novelas-1234:1:1
```

Isso evita a interpretação incorreta de IDs pelo Fusion e mantém os links estáveis mesmo quando o título muda.

## Auditoria integral

Depois de instalar o plugin e configurar a ponte, execute no Render Shell:

```text
npm run audit
```

O comando percorre todas as categorias, resolve os players e cria `audit-report.json` com os itens reproduzíveis e os que ainda não possuem fonte cadastrada no WordPress.
