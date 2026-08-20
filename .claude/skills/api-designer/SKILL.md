---
name: api-designer
description: Design de APIs do YourTime — contratos de Server Actions e Route Handlers, convenções de erro, paginação e webhooks. Use ao criar ou alterar qualquer interface entre client e servidor ou integrações externas.
---

# Designer de API — YourTime

Você atua como designer de APIs do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js App Router + TypeScript).

## Superfícies de API do projeto

1. **Server Actions** (mutações internas da loja/admin) — caminho padrão.
2. **Route Handlers** (`app/api/...`) — apenas para: webhooks de terceiros, endpoints consumidos fora do app (app mobile futuro), e callbacks OAuth.
3. **Integrações externas** (pagamento, frete) — sempre encapsuladas em `src/lib/<provedor>.ts`.

## Contrato de Server Action

```ts
// entrada validada com zod; saída discriminada, nunca throw para erro esperado
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; field?: string } };
```

- `ErrorCode` é união de literais do domínio: `"OUT_OF_STOCK" | "PAYMENT_DECLINED" | "RESERVATION_EXPIRED" | "VALIDATION" | "UNAUTHORIZED" | "NOT_FOUND" | "INTERNAL"`.
- `message` já vem no tom da marca (ver `brand-strategy`), pronta para exibir.
- Exceções (`throw`) ficam reservadas a erros inesperados → `error.tsx`.

## Convenções de Route Handler (REST)

- Recursos no plural, kebab-case: `/api/products`, `/api/orders/{id}`.
- Códigos: `200/201`, `400` validação, `401/403`, `404`, `409` conflito (ex.: estoque), `422` regra de negócio, `500`.
- Corpo de erro padronizado: `{ "error": { "code": "...", "message": "..." } }`.
- **Paginação por cursor** (`?cursor=...&limit=20`) no catálogo e pedidos; resposta `{ items, nextCursor }`.
- Filtros da listagem espelham a URL pública: `?brand=rolex&movement=automatic&minPrice=&maxPrice=&sort=price-asc`.

## Webhooks (recebidos)

- Verificar assinatura do provedor **antes** de ler o corpo como confiável.
- Idempotência: persistir `event_id` processado (unique) e ignorar duplicatas com `200`.
- Responder `2xx` rápido; trabalho pesado depois (ou tolerante a retry).
- Nunca confiar em valores do evento sem cruzar com o pedido no banco.

## Checklist ao criar/alterar um contrato

1. Entrada tem schema zod compartilhado entre client e server?
2. Todos os erros esperados têm `code` tipado e mensagem exibível?
3. Mudança é retrocompatível? (adicionar campo: ok; remover/renomear: exige migração dos consumidores)
4. Ação é idempotente onde o usuário pode clicar duas vezes (checkout!)?
5. Autorização verificada **dentro** da action/handler (não só na UI)?
