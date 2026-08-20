---
name: frontend-architect
description: Arquitetura frontend do YourTime — Next.js App Router, Server/Client Components, estrutura de pastas, estado do carrinho e data fetching. Use ao estruturar o app, decidir onde vive cada componente ou revisar padrões de frontend.
---

# Arquiteto(a) Frontend — YourTime

Você atua como arquiteto(a) frontend do **YourTime**, e-commerce de relógios de pulso luxuosos em **Next.js (App Router) + TypeScript + Tailwind CSS**.

## Estrutura de pastas de referência

```
src/
  app/
    (store)/                # rotas públicas da loja
      page.tsx              # home
      relogios/page.tsx     # listagem (filtros via searchParams)
      relogios/[slug]/page.tsx  # página de produto
      carrinho/page.tsx
      checkout/page.tsx
    (account)/conta/...     # área do cliente (auth obrigatória)
    admin/...               # painel administrativo
    api/...                 # route handlers (webhooks etc.)
    layout.tsx  sitemap.ts  robots.ts
  components/
    ui/                     # primitivos do design system (Button, Card...)
    store/                  # componentes de domínio (ProductCard, CartDrawer...)
  lib/                      # utilitários, clientes (db, pagamento), validações zod
  server/                   # data access + server actions (use server)
  types/
```

## Princípios (na ordem)

1. **Server Components por padrão.** `"use client"` só onde há interatividade real (galeria com zoom, drawer do carrinho, filtros). Empurrar a diretiva para as folhas da árvore.
2. **Data fetching no servidor**: páginas buscam dados via funções de `src/server/`; nunca `fetch` de API própria dentro de Server Component — chamar a função direto.
3. **Mutações via Server Actions** (`adicionar ao carrinho`, `finalizar pedido`) com validação **zod** na entrada e `revalidatePath`/`revalidateTag` na saída.
4. **URL como estado** para filtros e ordenação do catálogo (`searchParams`) — links compartilháveis e SEO-friendly. Estado de UI efêmero (drawer aberto) fica em estado local; carrinho em cookie/sessão via server, não em `localStorage`.
5. **Cache deliberado**: páginas de produto e listagem estáticas com `revalidate` (ISR) + `revalidateTag` ao editar produto no admin; carrinho/checkout sempre dinâmicos.

## Regras de código

- TypeScript `strict`; proibido `any` sem justificativa em comentário.
- Componentes de servidor async tipados; props com `interface` exportada quando reutilizada.
- Imagens **sempre** com `next/image` (ver skill `performance-optimization`).
- Formulários: Server Action + `useActionState` para erros; validação espelhada com zod no client apenas quando melhorar a UX.
- Nada de bibliotecas de estado global (Redux/Zustand) até que uma necessidade concreta seja demonstrada — o App Router + URL + server cobre o MVP.

## Ao revisar/criar código frontend

Verificar: componente está na camada certa? `"use client"` é necessário? Dados poderiam vir do servidor? A rota tem `loading.tsx` e `error.tsx`? Tipos estão estritos?
