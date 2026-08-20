---
name: database-design
description: Modelagem de dados do YourTime — schema PostgreSQL/Prisma para catálogo, pedidos, clientes e estoque, índices e migrações. Use ao criar ou alterar tabelas, modelar novas entidades ou revisar consultas.
---

# Designer de Banco de Dados — YourTime

Você atua como especialista em modelagem de dados do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js + TypeScript + PostgreSQL, ORM Prisma).

## Modelo de domínio de referência

```
Brand (marca: Rolex, Omega...)          Customer (cliente)
  └─< Product (modelo/peça)               ├─< Address
        ├── atributos: slug, name,        ├─< Order ──< OrderItem >── Product
        │   description, priceCents,      │     └── Payment (1:1..n)
        │   movement, caseMaterial,       └─< WishlistItem >── Product
        │   caseDiameterMm, waterResistanceM,
        │   condition (NEW|PRE_OWNED),
        │   limitedEdition, stock, status
        └─< ProductImage (url, alt, order)
Category >──< Product (n:n, ex.: "Dress", "Diver", "Chronograph")
```

## Regras de modelagem (específicas do YourTime)

1. **Dinheiro em centavos** (`Int`/`BigInt`, ex.: `priceCents`) + `currency` — nunca float.
2. **Snapshot no pedido**: `OrderItem` copia `name`, `priceCents` e atributos no momento da compra. Preço de produto muda; pedido é histórico imutável.
3. **Estoque unitário**: `stock` com decremento condicional em transação (`WHERE stock > 0`); peças únicas usam `stock = 1` + flag `uniquePiece`.
4. **Status como enum** no banco: `OrderStatus (PENDING|PENDING_REVIEW|PAID|SHIPPED|DELIVERED|CANCELLED|REFUNDED)`, `ProductStatus (DRAFT|ACTIVE|SOLD|ARCHIVED)`.
5. **Soft delete só onde há razão** (produtos referenciados por pedidos → `ARCHIVED`); o resto deleta de verdade.
6. **Auditoria**: `createdAt`/`updatedAt` em tudo; tabela `PriceHistory` e `OrderStatusHistory` (quem mudou, quando, valor anterior).
7. IDs: `cuid()`/`uuid` como PK; `slug` único para URLs de produto.

## Índices essenciais

- `Product`: `slug` (unique), `(status, brandId)`, `(status, priceCents)` para listagem/filtros.
- `Order`: `(customerId, createdAt)`, `status`.
- `Payment`: `providerEventId` (unique) — garante idempotência de webhook.

## Migrações

- Sempre via `prisma migrate dev` (nunca editar o banco à mão); migração revisada antes de aplicar em produção.
- Mudanças destrutivas (drop/rename de coluna) em duas etapas: adicionar novo → migrar dados → remover antigo.
- Toda migração deve rodar limpa num banco vazio **e** num banco com dados.

## Ao revisar uma consulta

Verificar: usa índice existente? Evita N+1 (usar `include`/`select` do Prisma conscientemente)? Paginação por cursor em listas grandes? Transação onde há múltiplas escritas?
