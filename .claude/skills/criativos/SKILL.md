---
name: criativos
description: Cria e ajusta artes (feed, stories, reels e anúncios) da própria empresa em código — HTML/SVG renderizado em PNG pelo Chrome headless e vídeo como motion graphics com ffmpeg. Use ao criar um modelo de arte novo, ao mexer em src/services/creatives/ ou ao escrever uma arte livre para um post ou anúncio. Sem API de geração, sem fotos, sem pessoas, sem marcas de terceiros.
---

# Criativos da própria empresa, feitos em código

O CRM (Agentes 6 e 7) precisa de imagem e vídeo para posts, stories, reels e anúncios **da própria empresa**.
Quem faz a arte é código renderizado localmente; nada é gerado por API paga e nada sai sem clique.

## O que é um criativo

| Formato  | Tamanho    | Tipo   | Observação                                                         |
|----------|------------|--------|--------------------------------------------------------------------|
| `feed`   | 1080×1350  | PNG    | 4:5                                                                |
| `story`  | 1080×1920  | PNG    | 9:16; topo (250 px) e rodapé (340 px) ficam sob a interface do app |
| `reel`   | 1080×1920  | MP4    | 9:16, H.264 yuv420p, áudio mudo, de 3 s a 60 s                     |
| `anuncio`| 1080×1080  | PNG    | 1:1                                                                |

Medidas e limites vivem em `src/lib/creative-policy.ts` (`CREATIVE_SPECS`, `COPY_LIMITS`, `VIDEO_LIMITS`).

## Regras que a verificação confere (se uma falhar, a arte não é entregue)

1. **Texto só do que a empresa já disse.** Toda palavra visível (inclusive `<title>` e `aria-label`) está em `copia.json`
   (`headline`, `body`, `cta`, `brand`). Não invente slogan, benefício, preço, prazo, número, depoimento nem adjetivo.
2. **Sem código nem recurso externo.** Nada de `<script>`, `<iframe>`, `<form>`, `<link>`, `<img>`, `<canvas>`, `<video>`,
   `src`, `on…=`, `@import` ou `url(http…)`. Fontes do sistema. SVG inline pode (`url(#id)` de gradiente também).
3. **Sem links.** A arte não tem `href` (use o link da bio ou o botão do anúncio).
4. **Sem pessoas, rostos, mãos, fotos de banco, logotipos ou marcas de terceiros**, nem "como se fosse do cliente".
   A linguagem visual é cor, tipografia, forma geométrica e espaço.
5. **Tamanho exato**: declare `width:<W>px; height:<H>px` no CSS da tela da arte e use `overflow:hidden`.
6. **Margem de segurança**: texto a pelo menos 84 px das bordas; em story/reel, fora das faixas do topo e do rodapé.
7. **Legibilidade**: contraste de texto de pelo menos 3:1 (mire em 4,5:1). Texto claro sobre fundo claro reprova.
8. Sem promessa de resultado, sem frase proibida do perfil (`never_say`).

## Onde está o código

- `src/services/creatives/templates.ts` — modelos de arte (3 composições: Bloco, Faixa, Noite). Para criar uma composição
  nova, some um item em `looks` e outro em `decoration`, aumente `LOOKS` e renderize os três formatos.
- `src/services/creatives/render.ts` — HTML → PNG (Chrome/Edge headless, `file://`) e a medição (texto fora da tela,
  margem, console, contraste).
- `src/services/creatives/video.ts` — cenas PNG → MP4 pelo ffmpeg (zoom lento + transição suave), `ffprobe` e decodificação.
- `src/services/creatives/engine.ts` — cria, verifica, grava, aprova e serve (`/midia/<token>/<arquivo>`, só aprovado).

## Como conferir uma mudança nos modelos

1. `npm test` (testes de `tests/creatives.test.ts`; o navegador e o ffmpeg são simulados).
2. Renderize de verdade os três formatos × três composições com o Chrome e **olhe as imagens**: título legível, nada
   cortado, nada sob a interface do app, contraste bom, a marca coerente.
3. Para vídeo, gere um reel e confira com `ffprobe` (H.264, yuv420p, 1080×1920, 30 fps, áudio presente).

## Quando o Claude Code escreve a arte livre (modo restrito)

A pasta de trabalho traz `copia.json`, `formato.json`, `BRIEF.md`, as skills de design e `arte.html` (a arte do modelo, de partida).
Reescreva `arte.html` à vontade, **dentro das regras acima**; a mesma verificação roda sobre o resultado e, se reprovar,
você recebe a lista exata do que falhou. Não há Bash nem internet: só ler e escrever arquivos desta pasta.

## O que nunca fazer

Publicar, ativar anúncio, gastar dinheiro, chamar API de geração de imagem ou vídeo, ler `.env*`, baixar fonte ou imagem da internet.
