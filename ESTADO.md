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


### Autenticação real (22/09/2026)
- Supabase Auth ativo quando `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` existem:
  e-mail e senha, link mágico, recuperação de senha, confirmação por e-mail.
  Sem as variáveis, o login demo continua igual.
- `src/proxy.ts` (o `middleware.ts` foi renomeado no Next 16) renova o token e
  faz a checagem otimista de rota; `getCurrentUser()` segue sendo a decisão
  que vale.
- `database/migrations/0004_auth.sql`: `app_users` (id = `auth.uid()`),
  `app_invites`, gatilho de cadastro e RLS. É o que faz as políticas da 0003
  valerem — antes o `owner_id` era um id de seed.
- Papéis: primeira conta vira owner, convidado recebe o papel do convite, o
  resto entra como viewer. A tela de Equipe esconde os controles de gestão de
  quem não é owner/admin (a action já recusava).
- Verificado no navegador contra um duplo local da API do Supabase: rota
  protegida → login com destino guardado, senha errada, login, sessão entre
  páginas, /login redirecionando quem já entrou, Equipe com a conta real,
  logout, e os três caminhos de papel. Regressão do modo demo refeita.
- **Não verificado ao vivo:** gatilho, políticas de RLS e Storage exigem um
  Postgres real (Supabase local com Docker ou projeto na nuvem).

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

### AgentOS: fundação e Agentes 1 e 2 (10/10/2026)
- Dashboard em `/agentes` (visão geral com funil real, uma página por agente e
  `/agentes/aprovacao`), fila durável, runner no mesmo processo do servidor,
  interruptor geral, modos pausado/aprovação/automático e tetos diários.
- Analista de Nicho (sondagem medida na fonte + score explicável) e Prospectador
  (reaproveita o job de prospecção). Filtro novo `weakWebsite` (sem site OU site
  fraco), porque `noWebsite` e `badWebsite` se excluem.
- Verificado no navegador, em produção local (`npm run build && npm start`):
  análise → ranking, prospecção manual (20 leads), proposta automática em
  aprovação → aprovar → 20 leads, teto diário atingido, interruptor geral
  recusando execuções, estado preservado após reiniciar, perfil vendedor sem
  controles de configuração, sem erro de console, celular sem rolagem lateral.
- Testes: `npm test` (inclui fila, políticas, aprovações, planejador, score e
  caracterização do job de prospecção). `mcp`: ferramenta `agentes_estado`.
- **Não verificado:** a migração `0005_agentes.sql` e o repositório do Supabase
  (`SupabaseAgentRepo`) — exigem um projeto Supabase de verdade (rode a 0005 e
  `node scripts/verificar-supabase.mjs`). Nem a análise com `GOOGLE_PLACES_API_KEY`
  real: no worktree de desenvolvimento só o diretório de demonstração foi exercitado.
- **Fica para as próximas fases:** Agentes 3–7, gateway de WhatsApp (portar o do
  `agenteitalo`), cliente Anthropic (`scripts/set-anthropic-key.mjs` já existe),
  worker em processo separado (exige migrar o núcleo do CRM para o banco).

### AgentOS: gateway de WhatsApp e tela de conexão — fase 3a (10/10/2026)
- Gateway portado do `agenteitalo` (Cobra) em `gateway/`: Baileys 7, sessão e
  chaves num **SQLite próprio** (`node:sqlite`, sem tocar o Supabase), reconexão
  com espera, QR que expira sem leitura, estados reais, filtro de status/grupos,
  modo de teste. Envio real **bloqueado** (501) até existir a política de envio.
- Caixa de saída durável: eventos gravados antes de qualquer envio, entregues ao
  CRM em ordem, por webhook com assinatura HMAC (janela de 5 min), reenviados com
  espera crescente; o CRM deduplica pelo id do evento e ignora evento fora de ordem.
- CRM: `POST /api/webhooks/whatsapp`, tabelas `whatsapp_link` e
  `whatsapp_receipts` (migração `0006_whatsapp.sql`), `/agentes/vendedor`
  (QR, conectar, desconectar, sair; só owner/admin), aviso global de "WhatsApp
  desconectado" e `scripts/set-whatsapp-gateway.mjs` (gera as chaves sem exibi-las).
- Verificado de verdade: gateway real obteve o **QR do WhatsApp** e a tela o
  exibiu; o aviso global e o estado chegaram ao CRM pelo webhook assinado; com o
  CRM derrubado, 3 eventos ficaram retidos e chegaram depois, na ordem e uma vez só.
- Testes: `npm test` (gateway com socket falso: QR→conectado, queda, saída,
  **reinício sem novo QR**, caixa de saída com CRM fora do ar; webhook; cliente;
  filtro de status portado da Cobra).
- **Não verificado:** a leitura do QR com um celular (exige o número dedicado) e,
  portanto, "Conectado" com número real e o reinício do gateway **com sessão
  pareada de verdade** (coberto só com socket falso); a migração `0006` no Supabase.
- **Próximas fases:** 3b (política e ciclos de envio, aprovação, `recipient`),
  3c (recebimento, classificação, reuniões, notificação ao seu WhatsApp).

### AgentOS: Vendedor, política e aprovação de mensagens — fase 3b (10/10/2026)
- **Vendedor** (`src/agents/seller/`, `src/services/outreach/`): escolhe leads dos agentes
  (score mínimo, celular brasileiro, fora da lista de bloqueio), confirma o WhatsApp
  do número pelo gateway (`recipient`, com teto diário de consultas), escreve a
  mensagem e a manda para **aprovação** (edição permitida; o aviso "responda PARE"
  é recolocado se for apagado). Nome de contato inventado pelas fontes
  automáticas nunca entra na mensagem.
- **Ciclos de envio** (`outreach_cycles`, migração `0007_vendedor.sql`, já no
  `setup-producao.sql`): um ativo por lead, reivindicação atômica, no máximo 3
  toques espaçados. Política no CRM: janela (seg–sex 9–18h, São Paulo), teto
  diário com aquecimento 10/20/30→máximo, intervalo aleatório, bloqueio.
- **Esperar não é falhar:** desconectado, modo pausado, fora da janela, teto ou
  intervalo adiam sem gastar tentativa; mensagem aprovada que passou do dia da
  etapa vira obsoleta e não sai. **Timeout vira "incerto" e nunca é reenviado**;
  um evento de entrega posterior o resolve.
- **Gateway só envia com autorização assinada pelo CRM** (HMAC preso a sessão,
  número, texto, referência e 2 min), com idempotência própria. Degraus:
  simulado → teste restrito (`WHATSAPP_ALLOWED_RECIPIENTS`) → real. A tela mostra
  o degrau atual e o gateway ganhou `GATEWAY_SIMULATE=1` (socket falso, só para desenvolvimento).
- Tela `/agentes/vendedor`: conexão, números do dia, fila, mensagens enviadas
  (enviada → entregue → lida), política editável, lista de bloqueio, tarefas e
  registro. Aprovação em `/agentes/aprovacao` com texto exato e edição.
- Verificado de verdade, ponta a ponta no navegador, com o gateway em modo
  simulado + teste restrito: 6 mensagens chegaram para aprovação, uma foi
  editada e aprovada, o gateway recusou-a enquanto o número não estava na lista
  (ficou "Agendada") e a enviou depois que entrou; o histórico foi enviada →
  entregue → lida e o texto enviado trazia a edição e o aviso de saída. A política
  inválida é recusada e a válida salva; sem rolagem lateral no celular.
- Testes: `npm test` (308), `tsc`, `lint` e `build` limpos.
- **Não verificado:** envio por um número de verdade (o gateway simulado troca o
  WhatsApp por um socket falso; falta o seu número dedicado) e a migração `0007`
  no Supabase. Os leads de teste e o gateway simulado foram desfeitos: `.data/db.json`
  voltou ao estado anterior.
- **Para ativar de verdade (passo 2):** conecte o número dedicado, ponha o seu
  número em `WHATSAPP_ALLOWED_RECIPIENTS` e `WHATSAPP_GATEWAY_DRY_RUN=0` no
  `.env.gateway`, reinicie o gateway e aprove uma mensagem de um lead de teste
  com o seu telefone. O passo 3 (real) é seu: ver `docs/WHATSAPP_LOCAL.md`.
- **Próximas fases:** 3c (recebimento, classificação, reuniões, notificação ao seu WhatsApp).

### AgentOS: conversa, reuniões e aviso ao dono — fase 3c (10/10/2026)
- **Recebimento:** o gateway entrega as respostas dos leads (padrão ligado) e o que **você** escreve
  pelo celular. O CRM liga ao lead pelo telefone (com ou sem o nono dígito), grava na conversa
  que já existia (`/conversas`), muda o lead para "respondeu", avisa no sino e dispara
  `lead.replied`. Número que não é de lead é ignorado, sem guardar o texto. Duplicata (mesmo
  evento ou mesma mensagem do WhatsApp com outro id de evento) não repete nada.
- **Pedido para parar:** regra fixa, antes de qualquer modelo (também com o agente pausado):
  bloqueia o número, encerra o lead e cancela follow-ups e pedidos pendentes. Sem resposta.
- **Você escreveu pelo celular:** a conversa passa a ser sua (`conversation_state`), o que o
  agente tinha a caminho é cancelado e nem um ciclo já aprovado sai depois disso. O eco das
  mensagens do próprio gateway é reconhecido (no gateway e no CRM) e não conta como você.
  "Assumir" e "Devolver ao agente" no painel fazem o mesmo à mão.
- **Classificação e resposta** (`services/conversation/`): usa o classificador de respostas
  que já existia (11 categorias) com o texto do lead isolado em `<cliente>` e mais barreiras;
  com `ANTHROPIC_API_KEY` (ou OpenAI) o modelo escolhe a categoria, sem chave valem as regras.
  Interesse, preço, proposta ou reunião → registra o interesse e propõe **dois horários** dentro
  da disponibilidade; o horário que o lead escolher marca a reunião (`meetings`, tarefa no CRM,
  lead em "reunião", `lead.interested` e `meeting.scheduled`). Retorno futuro, sem prioridade
  e "já tenho fornecedor" têm resposta curta; sem interesse encerra sem responder. Mídia,
  mensagem vaga, horário que não ficou claro, dúvida fora do roteiro, lead que o Vendedor nunca
  abordou ou frase proibida do perfil passam para **você** ("Precisam de você" + sino).
- **Segurança do texto do lead:** ele é dado. A resposta sai de modelos fixos (sem link, preço
  nem promessa), só para o telefone que o Vendedor já confirmou, e as barreiras valem também
  para o que você editar. Resposta parada há mais de 2 dias ou com horários vencidos não sai.
- **Aviso ao seu WhatsApp:** ao marcar a reunião, `owner_notices` envia pelo gateway (mesma
  autorização, idempotência e regra de "sem confirmação não repete") lead, dia/hora e o que o
  lead disse; o sino avisa sempre. Falha ou desconexão ficam visíveis na própria reunião.
- Migração `0008_conversa.sql` (já no `setup-producao.sql` e no verificador): `conversation_state`,
  `meetings`, `owner_notices`, e `kind` nos ciclos (abordagem x resposta, toque 0).
- Tela `/agentes/vendedor`: "Precisam de você", Conversas (com quem conduz cada uma), Reuniões
  (com o estado do aviso) e o formulário de disponibilidade e do seu WhatsApp. Respostas aparecem
  em `/agentes/aprovacao` com texto exato e edição.
- Verificado de verdade, ponta a ponta no navegador, com o gateway simulado (rota de mensagem
  simulada só em desenvolvimento) + teste restrito: abordagem aprovada e enviada; resposta
  "Gostei! Como funciona isso?" virou proposta de dois horários (aprovada e enviada); "Pode ser o
  segundo" marcou a reunião, criou a tarefa, e o aviso saiu para o número do dono; "PARE" bloqueou
  o outro lead sem resposta; uma mensagem "do celular" tirou a conversa do agente e retirou a
  confirmação pendente; sem rolagem lateral no celular.
- Testes: `npm test` (355), `tsc`, `lint` e `build` limpos.
- **Não verificado:** o recebimento de mensagens com um WhatsApp de verdade (o gateway simulado
  injeta pelo mesmo caminho, mas o Baileys real não foi exercitado; em particular o eco de envio
  e o endereço `@lid` só estão cobertos por teste), o classificador com um modelo de verdade
  (sem chave, só as regras foram exercitadas) e a migração `0008` no Supabase. Os leads e o
  gateway simulados foram desfeitos: `.data/db.json` voltou ao estado anterior.
- **Limites desta fase:** não há Google Calendar (a disponibilidade é a configurada) e nem dossiê
  (Agente 3), então o aviso não leva link de dossiê; a tela /conversas ainda não envia pelo
  WhatsApp (só o Vendedor envia).
- **Próximas fases:** F2 (Agente 3, dossiê), F4 (Agente 5, sites) e F5 (anúncios e Instagram).

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
  decisão. A autenticação real já existe (ver acima): ao abrir ao público,
  defina as variáveis do Supabase, rode a 0004 e confira as Redirect URLs.

## Não implementado (declarado como tal na interface)

- Automações e webhooks funcionam, mas WhatsApp, Gmail, Google Calendar e
  n8n seguem como cartões de status, sem integração.
- Conversas nunca são criadas pelo app; a lista vem do seed. O envio de
  mensagem grava no banco local, não sai para canal nenhum.
- Migração completa das 27 tabelas da `0001_initial.sql` (com Supabase Auth e
  RLS multi-tenant) continua pendente; a `0002` é só a fatia dos leads.
