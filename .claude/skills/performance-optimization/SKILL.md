---
name: performance-optimization
description: Performance do YourTime — Core Web Vitals, next/image para fotos de relógios, caching/ISR, bundle e consultas. Use ao otimizar páginas lentas, revisar uso de imagens ou definir estratégia de cache.
---

# Especialista em Performance — YourTime

Você atua como especialista em performance do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js App Router + TypeScript). Loja de luxo lenta destrói a percepção premium — a experiência deve ser tão precisa quanto os relógios.

## Metas (P75, mobile)

| Métrica | Meta |
|---|---|
| LCP | < 2,0s |
| INP | < 200ms |
| CLS | < 0,05 |
| JS por rota (first load) | < 150KB |

## Imagens — o maior risco do projeto

Fotos de relógio em alta resolução dominam o peso das páginas:

1. **Sempre `next/image`**, nunca `<img>`. Formatos AVIF/WebP automáticos.
2. LCP da página de produto = foto principal → `priority` nela (e **só** nela); demais fotos lazy.
3. `sizes` correto por contexto (card na grade ≠ galeria full) para não baixar imagem gigante no mobile.
4. Dimensões sempre definidas (evita CLS); zoom da galeria carrega a versão macro sob demanda.
5. Servir do CDN/blob com cache imutável (hash no nome do arquivo).

## Estratégia de cache por rota

- **Home, produto, listagens**: estáticas com ISR (`revalidate`) + `revalidateTag('product:{id}')` quando o admin edita — conteúdo muda pouco, tráfego alto.
- **Carrinho, checkout, conta, admin**: dinâmicas, sem cache.
- Dados compartilhados entre componentes da mesma renderização: buscar uma vez (React `cache()`), não repetir consulta.

## JavaScript

- Server Components por padrão (ver `frontend-architect`) — cada `"use client"` desnecessário é bundle no cliente.
- `next/dynamic` para componentes pesados fora da primeira dobra (zoom da galeria, mapas, chat).
- Verificar impacto com `next build` + `@next/bundle-analyzer` antes de adicionar dependência; preferir nativo/leve (ex.: `Intl.NumberFormat` para preço em BRL, não bibliotecas de formatação).
- Fontes com `next/font` (serifada + sans, subsets `latin`), `display: swap`.

## Banco e servidor

- Consultas das listagens com índices corretos e paginação por cursor (ver `database-design`); eliminar N+1 (`include` consciente no Prisma).
- Medir TTFB das rotas dinâmicas; checkout deve responder < 500ms no servidor.

## Método de trabalho

1. **Medir antes**: Lighthouse (mobile, throttling) + dados de campo (Vercel Analytics/CrUX).
2. Atacar o gargalo real (quase sempre: imagem LCP, JS de client component, consulta lenta).
3. **Medir depois** e reportar a diferença com números. Nunca otimizar às cegas.
