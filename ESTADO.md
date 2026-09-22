# Estado do projeto — 21/09/2026

Registro do que está pronto, do que está pela metade e do que falta, para
retomar sem precisar reconstruir o contexto.

## Pronto e verificado

### Acesso e segurança
- A aplicação exigia nenhuma autenticação: `getCurrentUser()` caía no owner
  quando não havia cookie, deixando todas as páginas e server actions
  abertas com privilégio máximo. Agora exige sessão e redireciona ao login.
- Server actions passaram a verificar sessão; organização, equipe e webhooks
  exigem owner/admin.
- Notificações eram lidas e marcadas sem filtro por usuário (havia um id de
  seed fixo no layout).
- Cookie de sessão com `secure` em produção; URL de webhook recusa endereços
  internos (SSRF); exportação CSV neutraliza injeção de fórmula.

### Dados
- `/leads` filtrava por origem e nunca mostrava lead nenhum — nem os criados
  pelos botões da própria página. Todas as origens voltaram a aparecer.
- `saveDb()` usava debounce sem await e perdia escritas em serverless; agora
  grava de forma síncrona. Arquivo inválido vai para quarentena com log em
  vez de ser descartado em silêncio.
- Falha de escrita não desliga mais a persistência para sempre: só `EROFS` é
  definitivo, o resto é reavaliado a cada 30 s. No Windows, o rename que
  falha com EPERM/EBUSY cai para escrita direta.

### Prospecção
- Entregava menos a cada repetição (25, 25, 25, 19, 14 em imobiliárias;
  advogado colapsava para zero na terceira). Causa: o gerador tinha 32 a 200
  nomes por nicho e e-mail/site/Instagram derivam do nome, então todo nome
  repetido colidia de quatro formas no dedupe. Hoje compõe nome + sobrenome
  e entrega 500 de 500 em 20 buscas seguidas.
- Job travava em "processando" para sempre quando a execução era
  interrompida; agora expira no servidor e a tela oferece saída.
- Os 5 passos exibidos eram 3 medições (dois pares dividiam contador); são 4
  passos com medições distintas.

### Automações e webhooks
- Eram CRUD sem execução: regras salvas, contador de execuções sempre zero,
  nenhum webhook disparado. Hoje há um barramento de eventos
  (`services/events.ts`) alimentando os dois consumidores.
- Motor com gatilho → condição → ação, ações idempotentes, e `runs`
  incrementando. Verificado: score 83 dispara "Priorizar leads quentes",
  move para Qualificado e cria a tarefa.
- Webhooks com assinatura HMAC SHA-256, timeout, um retry em 5xx, registro
  da última entrega e desativação após 10 falhas seguidas. Verificado com um
  receptor local: assinatura confere, falhas registradas, ping funciona.

### Google Maps (produção)
- Conectado e funcionando. A tela de Integrações tem "Testar conexão" que faz
  chamada real; as recusas do Google viram mensagens acionáveis.
- Cada prospecção alterna entre formas equivalentes de pedir o nicho, então
  buscas repetidas trazem empresas diferentes. Verificado: 3 prospecções de
  imobiliárias em Curitiba = 30 empresas reais distintas.
- Limite do formulário ajustado de 100 para 60 (teto do Text Search).


### Carreira (21/09/2026)
- Módulo novo em `/carreira`: upload de PDF, extração de perfil, análise com
  pesos publicados + sugestões com filtro anti-invenção, inspeção de links
  com cliente anti-SSRF, busca de vagas (Remotive/Adzuna/URL), aderência
  explicável, campanhas com fila durável, envio por Resend/Gmail, webhook de
  entrega, histórico com três estados independentes e exportação CSV.
- Verificado no navegador (headless): upload → análise → sugestão aceita →
  PDF revisado → perfil confirmado → busca (20 vagas reais do Remotive +
  fixtures) → revisão da campanha → ativação → candidatura registrada como
  "ação manual" (sem Resend configurado, nenhum e-mail sai).
- Testes: `npm test` (44 casos). Lint, typecheck e build limpos.
- Falta para produção: rodar `0003_carreira.sql`, definir `RESEND_*`,
  `CRON_SECRET`, `CAREER_TOKEN_SECRET` e (opcional) OAuth do Gmail, Adzuna e
  OCR. A autenticação real continua pendente — sem ela, o módulo é demo.

## Pela metade — Supabase

Objetivo: em produção o banco vive na memória da instância, então leads
prospectados somem quando a Vercel recicla o processo.

**Código pronto e commitado (68d5700):**
- `src/lib/supabase.ts` — cliente do servidor; devolve `null` sem credenciais,
  o que mantém o modo demo intacto.
- `src/services/lead-repository.ts` — cache de leitura com escrita espelhada.
  Carrega os leads do banco uma vez por instância e espelha as mutações
  depois da resposta. O desenho evita transformar em consulta de rede os
  cruzamentos que hoje são feitos em memória (88 pontos de acesso ao store,
  sem nenhum índice).
- `database/migrations/0002_leads_hibrido.sql` — três tabelas, índices e
  quatro restrições de unicidade contra lead repetido (source_id,
  nome+cidade, telefone só dígitos, Instagram sem @).
- Verificado que nada disso quebra o funcionamento sem Supabase.

**O que falta:**
1. Concluir a criação do projeto `prospecatlas` no Supabase (São Paulo,
   plano gratuito). A criação foi iniciada e interrompida — conferir se o
   projeto existe antes de recriar.
2. Rodar a `0002_leads_hibrido.sql` no SQL Editor.
3. Colar no `.env.local` e nas variáveis da Vercel:
   `NEXT_PUBLIC_SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`.
4. Testar de ponta a ponta: prospectar, derrubar o servidor, subir e conferir
   que os leads voltaram do banco.

**Obstáculo conhecido:** a organização do Supabase é gerenciada pelo Vercel
Marketplace e está no plano gratuito, que pausa projetos após uma semana sem
uso e limita projetos ativos. Há três projetos pausados
(`supabase-aquamarine-house`, `supabase-charcoal-window`,
`supabase-purple-queen`) que não puderam ser reativados sem upgrade. Mesmo
depois de tudo funcionando, o banco pode pausar por inatividade e a
persistência para até alguém reativar.

## Pendências fora do Supabase

- **Chave do Google exposta.** A chave em uso circulou em texto plano numa
  conversa e não foi regenerada. Trocar no Google Cloud e atualizar nos dois
  lugares (`.env.local` e Vercel).
- **Chave sem restrição.** Está como "Restrições do aplicativo: Nenhum".
  Restringir por IP reduz o risco de uso indevido na conta de faturamento.
- **Produção está privada** (Deployment Protection ativa na Vercel), por
  decisão. Antes de abrir ao público seria preciso autenticação real — a tela
  de login atual é do modo demo e entra sem senha.

## Não implementado (declarado como tal na interface)

- Automações e webhooks funcionam, mas WhatsApp, Gmail, Google Calendar e
  n8n seguem como cartões de status, sem integração.
- Conversas nunca são criadas pelo app; a lista vem do seed. O envio de
  mensagem grava no banco local, não sai para canal nenhum.
- Migração completa das 27 tabelas da `0001_initial.sql` (com Supabase Auth e
  RLS multi-tenant) continua pendente; a `0002` é só a fatia dos leads.
