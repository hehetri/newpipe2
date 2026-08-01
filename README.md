# NoveFlix Stremio 4.3

Addon Stremio que lê o catálogo direto do site NoveFlix — **sem plugin no WordPress** e sem patches por título. Roda no Render.

Código que importa:

| Arquivo | Papel |
| --- | --- |
| `src/index.js` | Manifest, handlers de catalog/meta/stream e rotas de diagnóstico |
| `src/catalog.js` | Catálogo (REST do WordPress → HTML) e detalhes de cada item, com cache |
| `src/resolver.js` | Descoberta dos players/URLs de mídia (HTTP → REST → navegador) |
| `src/parse.js` | Leitura do HTML: títulos, capas, links de conteúdo |
| `src/http.js`, `src/cache.js`, `src/config.js` | Rede, cache e configuração |

## Como o catálogo é montado

1. **REST do WordPress** (`/wp-json/wp/v2/categories` + `/posts`) — caminho principal: 2 requisições trazem até 100 itens por página com título, capa e link, e não quebra quando o tema do site muda.
2. **HTML do arquivo da categoria** (`/categoria/<key>/`, `/category/<key>/`, `/<key>/`) — fallback. Páginas são buscadas em paralelo; os cards são lidos pelo permalink canônico (`/assista/slug/`) e, se nada for encontrado, por heurística de post.
3. **Seeds do `config.js`** — última linha de defesa para o catálogo nunca voltar vazio.

Todo resultado fica em cache com janela *stale*: quando expira, o valor antigo continua sendo servido enquanto a atualização roda em segundo plano. Se o site estiver lento ou fora do ar, o Stremio recebe o catálogo antigo em vez de uma lista vazia.

## Orçamento de tempo (por que o metadata não falha mais)

Cada handler responde dentro de um limite, e o trabalho pesado continua em segundo plano:

| Requisição | Limite padrão | Observação |
| --- | --- | --- |
| `catalog` | 12 s | devolve cache/parcial e continua varrendo |
| `meta` | 9 s | nunca devolve `meta: null`; sem navegador headless |
| `stream` | 40 s | único ponto onde o Puppeteer entra |

A resolução de episódios sonda o CDN em paralelo (6 por vez), em vez de uma requisição por episódio em sequência.

## Deploy no Render

Build: `npm install` · Start: `npm start`

Variáveis (todas opcionais):

```text
NOVEFLIX_SITE=https://noveflix.co
NOVEFLIX_CDN=https://23rzv4udpdbv8t6.cdn-novflix.com
NOVEFLIX_BROWSER=0        # desliga o Puppeteer (útil em instância de 512 MB)
NOVEFLIX_WARMUP=0         # desliga o aquecimento do catálogo no boot
NOVEFLIX_META_BUDGET_MS=9000
NOVEFLIX_CATALOG_BUDGET_MS=12000
```

Instalação no Stremio/Fusion:

```text
https://newpipe2.onrender.com/manifest.json
```

## Diagnóstico

```text
GET /health                       estado de cada categoria, itens, origem e último erro
GET /diag/catalog/novelas         amostra do que foi raspado
GET /diag/meta/noveflix:novelas-quem-ama-cuida    detalhes + players resolvidos
GET /diag/cache                   chaves em cache
```

Se o catálogo aparecer vazio no app, `/health` diz onde parou: `source: "wp-rest" | "html" | "seeds" | "vazio"` e `lastError`.

## IDs

```text
noveflix:novelas-quem-ama-cuida
noveflix:novelas-quem-ama-cuida:1:5
```

O formato (`noveflix:<categoria>-<slug>`) e o id do manifest não mudaram — quem já tem o addon instalado continua com a biblioteca funcionando.

## Testes

```text
npm run selftest   # sobe um NoveFlix falso (REST + HTML + CDN) e valida catálogo, meta e streams
npm run check      # checagem de sintaxe
npm run audit      # percorre a biblioteca real e grava audit-report.json
```

O `selftest` cobre também os cenários que quebravam o app: site lento, site fora do ar e item que não está no catálogo.

## Legado

`addon*.js`, `server.js`, `config.js` (raiz), `lib/` e `wordpress/` são de arquiteturas anteriores (ponte via plugin WordPress) e não participam do runtime atual.
