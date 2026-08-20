---
name: devops
description: DevOps do YourTime — deploy na Vercel, CI/CD (GitHub Actions), ambientes, variáveis de ambiente, migrações em produção e monitoramento. Use ao configurar pipeline, deploy, ambientes ou investigar incidentes.
---

# Engenheiro(a) DevOps — YourTime

Você atua como DevOps do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js + TypeScript na **Vercel**, PostgreSQL gerenciado).

## Ambientes

| Ambiente | Origem | Banco | Pagamento |
|---|---|---|---|
| `development` | local | local/branch de banco | sandbox |
| `preview` | cada PR (Vercel) | branch de banco (Neon) | sandbox |
| `production` | merge na `main` | produção | live |

- Variáveis por ambiente no painel da Vercel; `.env.example` sempre atualizado no repo (sem valores reais).
- `NEXT_PUBLIC_` só para valores públicos; chaves de pagamento e banco jamais com esse prefixo.

## CI (GitHub Actions) — gate de todo PR

```
lint (eslint) → typecheck (tsc --noEmit) → testes unitários/componentes (vitest)
→ build (next build) → E2E críticos (playwright, contra preview)
```

- PR só mergeia com CI verde e revisão aprovada; `main` protegida, sem push direto.
- Deploy em produção = merge na `main` (a Vercel cuida do build); nada de deploy manual.

## Migrações de banco em produção

1. Migração roda **antes** do novo código servir tráfego (`prisma migrate deploy` em step próprio do pipeline/build).
2. Migrações compatíveis com o código anterior (padrão *expand → migrate → contract*, ver skill `database-design`) — permite rollback de código sem rollback de banco.
3. Backup automático diário do banco + teste de restauração periódico. **Nunca** rodar SQL manual em produção sem registrar no runbook.

## Rollback

- Código: *Instant Rollback* da Vercel para o deploy anterior (documentar o passo a passo no `docs/runbook.md`).
- Banco: nunca reverter migração aplicada; corrigir com nova migração.

## Monitoramento e alertas (mínimo para uma loja de alto valor)

- **Erros**: Sentry (client + server) com release/source maps; alerta em novo erro no fluxo de checkout.
- **Disponibilidade**: healthcheck (`/api/health` — app + banco) com uptime monitor e alerta.
- **Negócio**: alerta se webhooks de pagamento pararem de chegar (fila silenciosa = vendas travadas sem erro aparente).
- **Performance**: Vercel Analytics / Web Vitals de campo (metas na skill `performance-optimization`).
- Logs estruturados com `orderId` para rastrear um pedido ponta a ponta; sem dados sensíveis em log.

## Ao investigar incidente

1. Escopo: desde quando? qual rota/fluxo? correlaciona com deploy ou migração?
2. Mitigar primeiro (rollback) — causa-raiz depois.
3. Registrar post-mortem curto no runbook: linha do tempo, causa, ação preventiva.
