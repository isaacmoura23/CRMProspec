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

Caminho curto (os scripts não mostram nem registram nenhuma chave):

```bash
# 1. no painel do Supabase: crie o projeto (região São Paulo serve bem)
# 2. SQL Editor → cole database/setup-producao.sql → Run
node scripts/set-supabase.mjs        # pede URL e as duas chaves; gera os segredos próprios
node scripts/verificar-supabase.mjs  # diz o que ainda falta, item por item
npm run dev                          # confira o cadastro e o login em /login
```

Para publicar, repita as variáveis na Vercel e faça o deploy:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add CRON_SECRET production
vercel env add CAREER_TOKEN_SECRET production
vercel --prod
```

Em **Authentication → URL Configuration**, ponha a Site URL do ambiente e
inclua `https://SEU_HOST/auth/callback` nas Redirect URLs. Só então desligue
a Deployment Protection: enquanto o Supabase não estiver configurado, o site
sobe em modo demo e o login entra **sem senha**.

Passo a passo detalhado:

1. Crie um projeto no Supabase e rode, no SQL Editor:
   - `database/migrations/0002_leads_hibrido.sql` — leads, análises e score;
   - `database/migrations/0003_carreira.sql` — módulo Carreira e o bucket privado;
   - `database/migrations/0004_auth.sql` — `app_users`/`app_invites` e o gatilho de cadastro.
   (A `0001_initial.sql` é o schema completo de referência, para quando todo o
   domínio migrar; as três acima são as fatias que rodam hoje e não dependem dela.)
2. Preencha `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e
   `SUPABASE_SERVICE_ROLE_KEY`.
3. Em **Authentication → URL Configuration**, defina a Site URL do ambiente e
   inclua `https://SEU_HOST/auth/callback` nas Redirect URLs — é para lá que
   voltam a confirmação de e-mail, o link mágico e a redefinição de senha.

### Autenticação

Com essas variáveis definidas, o login demo (escolher um usuário sem senha) dá
lugar ao Supabase Auth: e-mail e senha, link mágico e recuperação de senha, em
`/login`. Sem elas o modo demo continua, declarado como tal na tela.

- A sessão vive em cookies; `src/proxy.ts` renova o token antes de a página
  renderizar (Server Components não podem escrever cookies) e manda quem não
  tem sessão para `/login?proximo=…`. A decisão que vale é a de
  `getCurrentUser()`, junto dos dados — o proxy é só a checagem otimista.
- `app_users` é a fonte de papel e organização. O id é o UUID de `auth.uid()`,
  o mesmo que vai em `owner_id` no módulo Carreira: é isso que faz as políticas
  de RLS da 0003 valerem.
- **Papel nunca vem do cliente.** A primeira conta da instância vira `owner`;
  quem foi convidado (Equipe → Convidar membro) entra com o papel do convite;
  o resto entra como `viewer`.
- Os usuários do seed desaparecem assim que existe conta real na organização.
  Leads de demonstração atribuídos a eles passam a mostrar "—".

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
  `/api/career/worker` (`vercel.json` + `CRON_SECRET`). O cron está diário
  porque o plano Hobby da Vercel só aceita uma execução por dia; no Pro, um
  intervalo menor (`0 */6 * * *`) deixa as campanhas recorrentes mais
  pontuais. Entre as execuções, quem abre a página também acorda a fila.
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

## Agentes (AgentOS)

Agentes que operam o funil sozinhos, observados pelo dashboard em **/agentes**.
Hoje há dois; o plano completo (dossiê, vendedor no WhatsApp, programador de
sites, tráfego e Instagram) está em [`PROMPT_AGENTOS.md`](PROMPT_AGENTOS.md).

| Agente | O que faz |
| --- | --- |
| **Analista de Nicho** | Para cada nicho × cidade, pede empresas ao Google Maps, mede quantas não têm site, visita uma amostra de sites para ver se são fracos e dá uma nota 0–100 com fatores publicados ("por que 89 pontos?"). Você fixa ou bane nichos. |
| **Prospectador** | Pega os nichos mais bem ranqueados e cadastra como leads as empresas **sem site ou com site fraco** (filtro `weakWebsite`; "Sem site" e "Site ruim" juntos se excluem). Reaproveita o job da tela de Prospectar. |

**Como funciona**

- O **runner** sobe junto com o servidor (`src/instrumentation.ts`) e vive no
  mesmo processo, porque o estado do CRM (snapshot e cache de leads) é por
  processo: um segundo processo sobrescreveria o do servidor. Por isso os
  agentes rodam **no seu computador** (`npm run build && npm start`), não na
  Vercel. `AGENTS_RUNNER=off` desliga só o runner.
- **Fila durável** (`agent_tasks`): lease, tentativas com backoff, 429 sem
  queimar tentativa, tarefa interrompida é retomada ao reiniciar, e uma que
  derruba o servidor repetidamente acaba falhando em vez de repetir para sempre.
- **Modos por agente:** *Pausado* (nada roda), *Em aprovação* (o que o agente
  decide iniciar vira um pedido em /agentes/aprovacao e só roda após o seu
  clique; nasce assim) e *Automático*. Há um **interruptor geral**. "Executar
  agora" por uma pessoa já conta como aprovação.
- **Tetos diários** de requisições ao Google e de leads (a cota é paga). Ao
  estourar, a tarefa espera o dia seguinte.
- O dashboard só mostra o que foi contado no banco: sem dado, estado vazio.
- Permissões: configurar, mudar modo, aprovar e fixar/banir exigem owner/admin;
  executar agora e cancelar, qualquer perfil de escrita.

**Dossiê (Agente 3):** o Analista de Presença Digital monta, para cada lead dos agentes, um
dossiê só com conteúdo público: site atual (nota por seis critérios, com o dado medido em cada
um), ficha do Google Maps, Instagram, Facebook, link na bio, YouTube, Mercado Livre e OLX. Cada
fonte tem o seu estado (concluída, parcial, bloqueada, pendente) e **toda afirmação carrega a
evidência** de onde veio; fonte que pede login ou barra o acesso aparece como bloqueada e baixa a
confiança, nunca é contornada. O resultado atualiza a qualidade do site do lead (com o rastro no
histórico) e a abordagem do Vendedor passa a falar do problema comprovado. Tela em
**/agentes/presence** e aba “Dossiê” em cada lead. A avaliação visual (capturas lidas por um
modelo) é opcional e vem desligada.

**Prévia do site (Agente 5):** quando um lead demonstra interesse de forma explícita e marca reunião, o
Programador de Sites monta uma prévia do site **só com o que o dossiê comprova** (sem imagem, depoimento,
preço nem endereço inventado), a verifica no navegador (erro de console, rolagem lateral no celular, capturas)
e a deixa num endereço não adivinhável, fora dos buscadores, antes da reunião. Sem interesse registrado e
reunião futura, nenhuma construção começa: é uma regra de código testada. Tela em **/agentes/site-builder**.

**Mídias Sociais e Tráfego (Agentes 7 e 6):** o agente de Mídias Sociais propõe, uma vez por dia, um post
para o Instagram (pauta, legenda e a ideia da imagem) a partir do perfil da empresa; o de Tráfego propõe
rascunhos de campanha e sugere pausar o que gasta sem resultado. **Nada sai sem o seu clique:** publicar é
"Aprovar e publicar" no próprio post, e uma campanha nasce rascunho — aprovar o rascunho não gasta nada, ativar
é outro clique, conferido contra os **tetos de gasto diário e mensal** no servidor. As ferramentas que mexem
fora do CRM (publicar, ativar, pausar, ajustar orçamento) não estão na lista de nenhum agente, e testes provam
isso. Telas em **/agentes/social-media** e **/agentes/traffic-manager**; para ligar o Instagram use
`node scripts/set-instagram-token.mjs`.

**WhatsApp (gateway):** o número dedicado à prospecção é conectado por um
gateway à parte (`npm run gateway`), que guarda a sessão num SQLite próprio e
entrega o estado da conexão ao CRM por webhook assinado, com caixa de saída
durável. Tela em **/agentes/vendedor**: conexão, fila de abordagem, mensagens
enviadas, política de envio e lista de bloqueio. O **Vendedor** confirma que o
número tem WhatsApp, escreve a primeira mensagem e a manda para **aprovação**
(`/agentes/aprovacao`, com edição); só então ela entra na fila de envio, que
respeita janela, teto diário, intervalo, máximo de 3 toques e aviso de saída. O
envio real é ativado em degraus (simulado → só o seu número → real). Responder
Quando o lead responde, o Vendedor trata o pedido para parar (bloqueio imediato),
classifica, propõe dois horários, marca a reunião e avisa no sino e no seu WhatsApp;
o que não sabe tratar, e tudo o que você escrever pelo celular, passa para você. Guia
completo, riscos e operação em [`docs/WHATSAPP_LOCAL.md`](docs/WHATSAPP_LOCAL.md).

Sem `GOOGLE_PLACES_API_KEY` os agentes usam o diretório de demonstração e tudo
que produzem é marcado como **dados de demonstração**.

**Supabase:** rode `database/migrations/0005_agentes.sql`, `0006_whatsapp.sql`, `0007_vendedor.sql`, `0008_conversa.sql`, `0009_dossie.sql`, `0010_sites.sql` e `0011_social_trafego.sql` (já estão em
`database/setup-producao.sql`) e confira com `node scripts/verificar-supabase.mjs`.
Sem Supabase tudo funciona no `.data/db.json`.

## Roadmap

- **Fase 2:** WhatsApp Business, Gmail/Calendar, cadências automatizadas com opt-out/LGPD, relatórios avançados.
- **Fase 3:** SDR IA com tools ("procure 50 imobiliárias no Porto sem site"), scoring preditivo, billing SaaS.
