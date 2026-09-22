# ProspecAtlas — CRM de Prospecção Inteligente com IA

> **"Nós ajudamos você a encontrar quem deveria virar seu próximo cliente."**

CRM de prospecção que **encontra** potenciais clientes, **enriquece** os dados, **analisa** a presença digital, **detecta problemas reais**, **calcula** o potencial comercial, **gera** abordagens personalizadas e **organiza** todo o funil — da descoberta ao fechamento.

**Produção:** https://prospecatlas.vercel.app

## Stack

- **Frontend:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Radix UI · Lucide
- **Backend:** Server Actions + jobs assíncronos in-process
- **Dados:** modo demo com store local (`.data/db.json`) · produção Supabase/PostgreSQL (migrations em `/database`)
- **IA:** OpenAI (opcional via `OPENAI_API_KEY`) com **engine determinístico de fallback** — o produto é 100% funcional sem nenhuma chave
- **Deploy:** Vercel

## Rodando localmente

```bash
npm install
npm run dev
# http://localhost:3000
```

Sem variáveis de ambiente, o sistema sobe em **modo demo**: banco local com seed realista (16 leads, análises, pipeline, tarefas, conversas) e IA determinística. Copie `.env.example` para `.env.local` e preencha as chaves para ativar OpenAI, Google Places e Supabase.

## Funcionalidades (MVP — Fase 1)

| Módulo | O que faz |
| --- | --- |
| **Dashboard** | KPIs com comparação de período, funil com taxas, "o que precisa da sua atenção", melhores oportunidades |
| **Prospectar** | Busca por nicho/localização/características com tela de processamento **real** (encontrar → enriquecer → presença digital → analisar → pontuar) |
| **Leads** | Tabela com filtros, ordenação, busca, ações em lote, colunas configuráveis, importação CSV (mapeamento + dedupe) e exportação |
| **Perfil do lead** | Análise IA com problema concreto + impacto + solução, score explicável ("por que 87 pontos?"), timeline, notas |
| **Abordagens IA** | 7 formatos (curta, consultiva, WhatsApp, DM, e-mail, roteiro de áudio, follow-up) e 4 ajustes de tom; nunca genérica — usa o problema identificado |
| **Pipeline** | Kanban drag-and-drop com etapas editáveis, valor potencial e dias na etapa |
| **Follow-ups** | Agrupados por vencimento, com contexto da última interação e sugestão da IA |
| **Conversas** | Inbox unificado com classificação automática de respostas e resposta a objeções |
| **Análises IA** | Assistente comercial que **consulta dados reais** ("quais leads devo abordar hoje?") |
| **Automações** | Motor gatilho → condição → ação que **executa de fato**: move etapa, cria tarefa, pausa cadência, notifica |
| **Webhooks** | Entrega assinada (HMAC SHA-256) dos eventos do CRM, com teste manual, status da última entrega e retry |
| **Campanhas / Propostas / Clientes / Relatórios / Equipe / Configurações** | Gestão completa, incluindo o perfil "Sobre minha empresa" que contextualiza a IA |

## Arquitetura

```
src/
  ai/            prompts centralizados + cliente LLM + engine determinístico
  actions/       server actions (validação Zod)
  app/           rotas (App Router) — (app)/ é a área autenticada
  components/    UI base + layout
  features/      componentes por módulo (leads, pipeline, prospecção…)
  jobs/          jobs assíncronos (prospecção com etapas reais)
  lib/           store, auth, formatação, seed
  providers/     fontes de prospecção (interface LeadProvider + registry)
  services/      scoring, dedupe, estatísticas, lead-service
                 + barramento de eventos (events), motor de automações
                   (automations) e entrega de webhooks (webhooks)
  types/         modelo de domínio
database/
  migrations/    schema PostgreSQL/Supabase com RLS multi-tenant
```

### Eventos, automações e webhooks

Um único barramento (`services/events.ts`) alimenta os dois consumidores, a
partir do catálogo em `services/event-catalog.ts`:

- **Automações** rodam de forma síncrona, porque mudam dados que a resposta
  já vai renderizar. As ações mutam o banco direto em vez de reentrar no
  barramento — é o que impede uma regra de reagir à própria consequência.
- **Webhooks** saem depois da resposta (`after()`), com timeout de 8 s, um
  retry em 5xx e assinatura `X-ProspecAtlas-Signature: sha256=…` (HMAC do
  corpo com o segredo mostrado na criação). Dez falhas seguidas desativam a
  entrega; a tela mostra o status da última e permite um envio de teste.
- O que a automação causa também vira evento para os webhooks, marcado com
  `fromAutomation` para não reentrar no motor.

`lead.stale` ("sem contato há 5 dias") não tem um instante em que ocorre.
Sem agendador, a varredura roda no máximo a cada 5 minutos, disparada pela
navegação.

### Princípios de produto

- **Score explicável:** todo score mostra os fatores que o compõem; histórico preservado.
- **Problema concreto:** a análise nunca gera frases vagas — descreve uma situação específica e verificável do negócio.
- **Curiosidade antes da solução:** a primeira abordagem não revela a solução completa.
- **Sem dados inventados:** o assistente consulta o banco; confidence honesto quando faltam dados.
- **Progresso real:** a tela de prospecção reflete os jobs efetivamente processados.
- **Resposta pausa cadência:** lead respondeu → follow-ups automáticos pausam. É
  uma automação editável, não uma regra fixa no código.

## Conectar ao Google Maps (empresas reais)

Sem chave, a prospecção usa um diretório de demonstração — empresas geradas,
coerentes com o nicho e a cidade, mas fictícias. Com a chave, a busca passa a
vir do Google Maps, com telefone, site e avaliações reais de cada negócio.

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie ou
   escolha um projeto.
2. Ative a **Places API (New)** na biblioteca de APIs.
3. Vincule uma conta de faturamento ao projeto — a API exige, e há cota
   gratuita mensal.
4. Em **Credenciais → Criar credenciais → Chave de API**, gere a chave.
5. Defina `GOOGLE_PLACES_API_KEY` no `.env.local` e reinicie (`npm run dev`).
   Em produção, a mesma variável vai em **Vercel → Settings → Environment
   Variables**, seguida de um novo deploy.

Confira em **Integrações**: o card do Google Places tem um botão *Testar
conexão* que faz uma chamada real e mostra o que voltou. Ele distingue chave
inválida, API não habilitada, faturamento ausente e cota esgotada — cada uma
pede uma ação diferente. Quando a conexão está ativa, a tela de Prospectar
passa a indicar "Conectado ao Google Maps".

Limites que valem saber: o Text Search devolve no máximo 60 resultados por
busca (então um pedido de 100 entrega até 60), e o nicho é validado contra os
tipos do Google — um termo muito fora do vocabulário do Google Maps pode não
casar com nada, e a busca diz isso em vez de terminar vazia sem explicação.

## Produção com Supabase

1. Crie um projeto no Supabase e rode `database/migrations/0001_initial.sql` no SQL Editor (schema completo com RLS por organização).
2. Preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. O isolamento multi-tenant é garantido por Row Level Security (`member_organizations()`).

## Carreira (currículo, vagas e candidaturas)

Módulo em `/carreira`, separado do funil comercial: candidatos não são leads
e nada do currículo vai para os webhooks do CRM.

**Fluxo:** enviar PDF → extrair perfil → analisar currículo e links → aceitar
correções (com PDF revisado opcional) → definir preferências → buscar vagas →
revisar a campanha → executar candidaturas → acompanhar cada envio.

**Como funciona por baixo**

- PDF validado no servidor (assinatura, tamanho ≤ 10 MB, parser), com texto por
  página e links tanto do texto quanto das anotações de hyperlink. PDF
  digitalizado depende de OCR (`OCR_SPACE_API_KEY`); sem ele, a interface diz
  que a leitura está indisponível.
- Análise com pesos publicados (8 critérios) pelo motor determinístico
  (`services/career/analysis-engine.ts`); com `OPENAI_API_KEY`, o modelo
  acrescenta correções que só entram se citarem trecho literal do currículo e
  não introduzirem números novos. Layout visual fica declarado como "não
  avaliado" (exige renderização das páginas).
- Links são visitados por um cliente HTTP com bloqueio de SSRF
  (`lib/safe-url.ts` + `services/career/safe-fetch.ts`): DNS resolvido e
  conferido, conexão no IP validado, redirecionamentos revalidados, limites de
  bytes/tempo/concorrência. LinkedIn é reportado como bloqueado (exige login).
- Vagas: `providers/jobs/` — Remotive (sem chave, vagas remotas), Adzuna
  (`ADZUNA_*`), importação por URL (JSON-LD `JobPosting`) e fixtures apenas com
  `CAREER_DEMO_JOBS=true`. Aderência explicável em `services/career/matching.ts`.
- Envio: Resend (`RESEND_*`, remetente de domínio verificado, um e-mail por
  candidatura com PDF anexo — a API Batch não aceita anexos) ou Gmail (OAuth
  `gmail.send`, tokens cifrados com `CAREER_TOKEN_SECRET`). Anúncio sem e-mail
  publicado vira "ação manual" com link, currículo e mensagem prontos.
- Fila durável (`services/career/queue.ts`): jobs com lease, tentativas,
  backoff com jitter e tratamento de 429; sobrevive a reinício. Acordada por
  `after()` nas actions, pela própria página e por cron em
  `/api/career/worker` (`vercel.json` + `CRON_SECRET`).
- Webhook do Resend em `/api/webhooks/resend` com assinatura Svix verificada
  sobre o corpo bruto, tolerância de replay e deduplicação por `svix-id`.
- Persistência: snapshot local em demo; com Supabase, tabelas `career_*` e
  bucket privado `career-resumes` (`database/migrations/0003_carreira.sql`,
  com RLS por titular).

**Testes:** `npm test` (node:test via tsx) cobre SSRF, PDF textual/sem
texto/inválido, hyperlinks de anotação, filtros anti-invenção, matching,
mensagens sem placeholder, isolamento entre titulares, deduplicação, lease
concorrente, reinício de worker, pausa/cancelamento, timeout após aceite com
reconciliação idempotente, webhook falso/repetido/fora de ordem, quota e
ausência de credenciais. `npm run typecheck` e `npm run lint` completam.

**Antes de usar com dados reais:** ativar autenticação real (a sessão demo
identifica o titular por cookie sem senha) e rodar a migração 0003 — as
políticas de RLS e de Storage só valem com Supabase Auth.

## Roadmap

- **Fase 2:** WhatsApp Business, Gmail/Calendar, cadências automatizadas com opt-out/LGPD, relatórios avançados.
- **Fase 3:** SDR IA com tools ("procure 50 imobiliárias no Porto sem site"), scoring preditivo, billing SaaS.
