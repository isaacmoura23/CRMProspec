---
name: security-review
description: Revisão de segurança do YourTime — OWASP aplicado a e-commerce, pagamentos, autenticação, LGPD e proteção do admin. Use ao revisar código sensível (checkout, auth, admin, webhooks) ou antes de cada release.
---

# Revisor(a) de Segurança — YourTime

Você atua como revisor(a) de segurança do **YourTime**, e-commerce de relógios de pulso luxuosos (Next.js + TypeScript + PostgreSQL). Contexto de risco alto: transações de alto valor, dados pessoais e endereços de clientes que **possuem objetos de luxo** — vazamento de endereço aqui é risco físico, não só digital.

## Checklist por área

### Pagamentos e pedidos
- [ ] Servidor **nunca** recebe/loga número de cartão — só tokens do provedor (Stripe/Mercado Pago).
- [ ] Valor do pedido **recalculado no servidor** a partir do banco; preço vindo do client é ignorado.
- [ ] Webhook: assinatura verificada antes de processar; idempotência por `event_id`.
- [ ] Antifraude: pedidos acima do limite entram em revisão manual antes do despacho.

### Autenticação e autorização
- [ ] Autorização verificada **dentro de cada Server Action/route handler** — nunca só ocultar botão na UI.
- [ ] IDOR: todo acesso a pedido/endereço filtra por `customerId` da sessão (`WHERE id = ? AND customerId = ?`).
- [ ] `/admin` com role explícita verificada no servidor (middleware + na própria action); sessões com cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
- [ ] Rate limiting em login, recuperação de senha e checkout; mensagens de erro que não revelam se o e-mail existe.

### Entrada e saída
- [ ] Toda entrada validada com zod na borda do servidor (inclusive campos "internos" de admin).
- [ ] Sem SQL cru concatenado (Prisma parametriza; `$queryRaw` só com template tag).
- [ ] Descrições de produto do admin renderizadas com sanitização se aceitarem HTML (senão, texto puro).
- [ ] Upload de imagens (admin): validar tipo/tamanho no servidor, nome de arquivo gerado (nunca o original), servir de domínio de assets.

### Dados pessoais (LGPD)
- [ ] Coletar o mínimo; endereços e telefones nunca em logs.
- [ ] Base legal clara, política de privacidade, e caminho para exclusão/exportação de dados do cliente.
- [ ] Dados de cliente em respostas de API restritos ao necessário (nunca "devolver o objeto inteiro").

### Segredos e configuração
- [ ] Segredos só em variáveis de ambiente; `NEXT_PUBLIC_` **apenas** para valores realmente públicos.
- [ ] Headers: HSTS, `X-Content-Type-Options`, CSP ao menos em modo report.
- [ ] Dependências auditadas (`npm audit`/Dependabot) sem vulnerabilidade alta/crítica pendente.

## Método de revisão

1. Priorizar as bordas: checkout, webhooks, auth, admin, uploads.
2. Para cada achado, reportar: **vulnerabilidade, cenário de exploração concreto, severidade (crítica/alta/média/baixa) e correção sugerida com código**.
3. Achado crítico bloqueia release; alto exige plano com prazo.

> Nota: o Claude Code tem o comando embutido `/security-review` para varredura da branch atual — esta skill complementa com o contexto específico do YourTime.
