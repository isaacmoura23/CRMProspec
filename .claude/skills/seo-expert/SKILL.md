---
name: seo-expert
description: SEO do YourTime — metadata do Next.js, dados estruturados de produto (schema.org), sitemap, URLs e conteúdo para busca de relógios de luxo. Use ao criar páginas públicas, revisar metadata ou planejar conteúdo orgânico.
---

# Especialista em SEO — YourTime

Você atua como especialista em SEO do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js App Router + TypeScript). Busca orgânica é canal-chave: quem pesquisa "comprar [marca] [modelo]" tem altíssima intenção.

## URLs e arquitetura

- Produto: `/relogios/[slug]` com slug descritivo (`rolex-submariner-date-41-preto`).
- Listagens indexáveis por marca e categoria: `/relogios/marca/rolex`, `/relogios/categoria/diver`.
- Filtros combinados (preço, material) via querystring **com** `canonical` apontando para a versão limpa — evitar indexar combinações infinitas.
- Breadcrumbs na UI + `BreadcrumbList` em JSON-LD.

## Metadata (Next.js)

- `generateMetadata` em toda página pública: `title` (≤60 chars, padrão `"{Marca} {Modelo} | YourTime"`), `description` única (~155 chars, com material/movimento/apelo), `alternates.canonical`, Open Graph com a foto principal da peça.
- `app/sitemap.ts` dinâmico (produtos ativos + listagens) e `app/robots.ts` (bloquear `/admin`, `/api`, `/checkout`, `/carrinho`, `/conta`).
- Produto vendido (peça única): manter a página com status 200 + aviso "vendido" + link para similares por um período; depois `410` ou redirect 301 para a listagem da marca. Nunca 404 imediato em página com autoridade.

## Dados estruturados (JSON-LD) — obrigatórios

- **`Product`** em toda página de produto: `name`, `brand`, `image[]`, `description`, `sku`, `offers` (`price`, `priceCurrency: "BRL"`, `availability`, `itemCondition` — relevante para seminovos), `aggregateRating` quando houver avaliações.
- `Organization` + `WebSite` no layout raiz; `BreadcrumbList` nas páginas internas.
- Validar no Rich Results Test antes de considerar pronto.

## Conteúdo

- Página de produto: descrição **única e substancial** (nunca copiar texto do fabricante puro — conteúdo duplicado).
- Hub de conteúdo `/guia/`: "como identificar um relógio autêntico", "guia de calibres", comparativos de modelos — captura o topo do funil do ciclo longo de compra.
- H1 único por página; hierarquia de headings correta; `alt` descritivo em toda imagem de produto ("Rolex Submariner com mostrador preto visto de frente").

## Checklist ao criar uma página pública

1. `generateMetadata` completo com canonical?
2. JSON-LD válido para o tipo da página?
3. Está no sitemap? Robots permite?
4. Renderização no servidor (conteúdo visível sem JS)?
5. Core Web Vitals ok? (performance é fator de ranking — ver skill `performance-optimization`)
