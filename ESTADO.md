# Estado do projeto — 10/10/2026

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

### AgentOS: Analista de Presença Digital (dossiê) — fase 2 (11/10/2026)
- **Agente 3** (`src/agents/presence/`, `src/services/presence/`): monta, para cada lead dos agentes (do maior
  score ao menor, com teto por dia e no máximo 2 em montagem), um dossiê só com conteúdo público.
  Entra na fila direto (só lê e só escreve o dossiê). Tela `/agentes/presence` e aba "Dossiê" no lead.
- **Fontes, cada uma com estado** (concluída, parcial, bloqueada, pendente): site atual, ficha do Google
  Maps (dados do próprio cadastro do Places), Instagram, Facebook, link na bio, YouTube, Mercado Livre e OLX.
  Cliente HTTP anti-SSRF (DNS resolvido, IP conferido, conexão fixada, cada redirecionamento revalidado);
  login, 403, 429 e desafio anti-robô viram **"bloqueada"** e baixam a confiança — nada é contornado.
  Mercado Livre e OLX só pelos links que o próprio site publica (procurar por nome daria vendedor errado).
- **Toda afirmação tem evidência:** o dossiê só aceita afirmação com trecho de origem; `validateDossier`
  confere o conjunto e um dossiê que quebra a regra nem é gravado. Lead de demonstração: nada é consultado.
- **Nota do site por rubrica** (seis critérios, 0 a 5, cada um com o dado medido): responsividade,
  hierarquia, clareza da oferta, prova social, chamada para ação e atualização técnica. O resultado
  **atualiza `website_quality`** (só com veredito completo; site barrado não muda nada) e os contatos que
  o lead não tinha, sempre com o rastro no histórico. Domínio à venda, "em construção" e construtor
  gratuito são "ruim"; sem a tag viewport nunca passa de "desatualizado".
- **Avaliação visual (opcional, desligada):** captura desktop e celular com o Chrome/Edge instalado e envia
  a um modelo com visão (Anthropic) uma nota por critério. A resposta é validada, limitada a 0–5 e a
  observação é guardada como opinião do modelo. As imagens saem do computador: por isso vem desligada.
- **Vendedor:** passa a exigir dossiê (configurável; vale só enquanto o Agente 3 está ligado — pausá-lo libera o
  Vendedor) e a mensagem de abordagem fala do **problema que o dossiê comprovou** em vez da análise genérica.
- Texto de páginas é dado, nunca instrução: teste de injeção cobre uma página que manda classificar o site
  como "bom" e enviar dados a um número — a nota não muda.
- Migração `0009_dossie.sql` (já no `setup-producao.sql` e no verificador), evento `lead.dossier_ready`.
- Verificado de verdade: busca real a um site público (nota e motivos), Instagram real devolvendo "bloqueada",
  bloqueio de 127.0.0.1 e do endereço de metadados, captura real desktop e celular com o Chrome instalado
  (PNG válido), e no navegador: dossiês montados pelo runner, aba "Dossiê" do lead, qualidade do site
  atualizada com rastro, sem rolagem lateral no celular.
- Testes: `npm test` (387), `tsc`, `lint` e `build` limpos.
- **Não verificado:** a leitura visual pelo modelo (não há chave da Anthropic neste ambiente: só a captura foi
  exercitada, e a resposta do modelo por teste com simulação), Facebook/YouTube/Mercado Livre/OLX reais, e a
  migração `0009` no Supabase. Os leads de teste foram removidos: `.data/db.json` voltou ao estado anterior.
- **Limites:** sem transcrição de vídeo, sem ofertas detalhadas, imagens e tom de voz (a F4 precisa deles e os
  extrai do próprio site), e sem Playwright — só o navegador instalado, em modo headless.

### AgentOS: Programador de Sites (prévia) — fase 4 (11/10/2026)
- **A porta** (`src/lib/site-gate.ts`, função pura testada): a construção só começa com o lead em "interessado" ou
  "reunião", **interesse explícito registrado** (a mensagem do lead que o comprova, gravada pela fase 3c), **reunião
  agendada com data futura**, **tempo hábil** (pronta até reunião − 2 h; sem tempo, avisa em vez de entregar pela
  metade) e **dossiê válido e real** com o mínimo (nome e um contato). `enqueueSiteBuild` **lança erro** se qualquer
  uma faltar, e a porta é conferida de novo quando a tarefa começa.
- **Entrada só o dossiê** (Agente 3, que agora guarda um `profile` com os campos comprovados e a origem de cada
  um). O gerador (`lib/site-generate.ts`) é determinístico, não um modelo: cada texto da página é um valor do perfil ou
  uma palavra do vocabulário fixo da interface. Página estática (HTML + CSS inline), **sem script, sem imagem e sem
  recurso externo**; seção sem dado não existe; nada de depoimento, preço ou foto de banco. Loja virtual fica de fora:
  a v1 é vitrine com pedido pelo WhatsApp.
- **Verificação independente** (`lib/site-verify.ts` + navegador): nada de texto fora do dossiê (palavra a palavra),
  links só os do perfil, contatos idênticos, noindex, sem recurso externo; e no **Chrome/Edge headless**: erro de
  console, rolagem lateral no celular, âncoras quebradas e capturas de tela desktop e celular. Qualquer falha e a
  prévia não é entregue (arquivos apagados). Sem navegador a prévia também não sai (configurável).
- **Prévia** em `/previa/<token>` (192 bits aleatórios, pública para o proxy porque quem recebe não tem conta):
  `X-Robots-Tag: noindex`, CSP sem script, `no-store`, expira depois da reunião (7 dias) e pode ser tirada do ar. Só
  uma prévia viva por lead. Capturas pelo painel autenticado. Aviso no sino e no seu WhatsApp (`owner_notices`,
  `kind=previa`; o endereço completo só vai se houver `PUBLIC_BASE_URL`).
- Tela `/agentes/site-builder` (prévias, reuniões esperando com o motivo da porta fechada, configuração) e cartão da
  prévia na aba Dossiê do lead. Migração `0010_sites.sql` (já no `setup-producao.sql` e no verificador).
- Verificado de verdade: do dossiê à prévia no runner com o Chrome instalado (12 de 12 verificações), endereço servido
  com os cabeçalhos certos, token errado e fora do formato dando 404, cartão no lead, e a prévia aberta no navegador.
- Testes: `npm test` (425), `tsc`, `lint` e `build` limpos.
- **Desvios da especificação:** o gerador é por modelos, não Claude Code com Skills/Playwright/Figma (não dá para
  verificar uma construção por modelo de linguagem sem uma chave, e a verificação aqui é a mesma que valeria para
  ela); a verificação de navegador usa o Chrome/Edge instalados em modo headless, não o Playwright MCP; imagens do
  cliente não são usadas (a prévia não tem imagem nenhuma); não há deploy de prévia em hospedagem — o endereço vive no
  seu computador (para mostrar fora dele, aponte `PUBLIC_BASE_URL` para um túnel seu); publicar de verdade
  exigiria consentimento e não existe.
- **Não verificado:** a migração `0010` no Supabase e o comportamento com sites reais de clientes (o teste ao vivo
  usou um site público de exemplo, com pouco conteúdo).

### AgentOS: Mídias Sociais e Gestor de Tráfego — fase 5 (11/10/2026)
- **A regra, em código e provada por teste:** nenhuma publicação nem alteração de gasto sem clique. As ferramentas
  que mexem fora do CRM (`instagram.publish_media`, criar/ativar/pausar campanha, ajustar orçamento) estão em
  `HUMAN_ONLY_TOOLS`, **fora da lista de qualquer agente** (`src/agents/tools.ts`); um teste confere que (a) nenhum
  agente as recebe, (b) o código dos agentes não importa nem cita as funções de publicar/ativar/pausar/ajustar, e
  (c) o módulo de publicar (`instagram-publisher.ts`) só é importado pelo serviço que a ação do botão chama. Outro
  teste roda os dois agentes em modo **automático**, com o Instagram configurado, e prova que não houve nenhuma
  chamada de escrita à API e que nenhuma campanha foi ativada.
- **Agente 7 — Mídias Sociais** (`src/agents/social/`): uma proposta por dia (pauta, legenda e ideia de imagem) só
  com fatos do perfil da empresa, sem repetir pauta recente (olha também os posts publicados quando o Instagram
  está ligado). Legenda passa por barreiras (sem link, sem promessa, sem frase proibida, tamanho, hashtags). Estados:
  rascunho → pendente → aprovado → publicando → publicado | falhou, mais recusado e expirado. **"Aprovar e
  publicar"** (`approveAndPublish`) é a única passagem que publica: reivindica o post de forma **atômica** (dois
  cliques ou duas abas publicam uma vez só), confere legenda e imagem, e só então chama a API Graph. Falha definitiva
  pode ser reaberta para um novo clique; **sem confirmação vira "incerta"** (nunca se repete sozinha: conferir no
  Instagram ou marcar que não saiu). Editar legenda e imagem antes de aprovar. Aprovar um post pela fila genérica
  de aprovação **não** publica.
- **Agente 6 — Gestor de Tráfego** (`src/agents/traffic/`): um rascunho de campanha por semana, e uma revisão diária
  dos relatórios que **só propõe** pausar o que gasta sem converter ou tudo o que passou do teto (e avisa no sino).
  Toda campanha nasce rascunho em `approvals`; **aprovar o rascunho não gasta nada, ativar é outro clique**. Ativar
  e subir orçamento conferem os **tetos diário e mensal** no servidor (soma dos orçamentos ativos; gasto do mês +
  previsto até o fim do mês) e são atômicos. Dinheiro em centavos. Provedor **manual**: você cria a campanha na
  plataforma e o CRM guarda o controle, os tetos e os relatórios (lançados à mão).
- Telas `/agentes/social-media` (posts, edição, imagem, conferência de incertos, configuração e passo a passo do
  Instagram) e `/agentes/traffic-manager` (gasto e tetos, campanhas, relatório do dia, tetos configuráveis).
  `scripts/set-instagram-token.mjs` grava ID e token sem expor o token. Migração `0011_social_trafego.sql`
  (já no `setup-producao.sql` e no verificador).
- Testes: `npm test` (461), `tsc`, `lint` e `build` limpos.
- **(Atualizado na fase 6:** a arte do post agora é gerada em código e o agente propõe pelo calendário; o parágrafo abaixo
  descreve o que valia na fase 5.)
- **Desvios da especificação:** o Instagram é falado direto pela API Graph (HTTP, com o token no cabeçalho), não por
  um servidor MCP Python (`ig-mcp`) — a garantia é a mesma e não há processo extra; o AdKit é um serviço pago e
  hospedado cujo protocolo não dá para verificar daqui, então o Agente 6 entrega o núcleo (rascunhos, aprovação,
  tetos, relatórios) com o provedor manual, e as plataformas entram atrás da mesma interface quando houver conta;
  a imagem do post é um endereço público que VOCÊ informa (o agente sugere a ideia, não gera imagem).
- **Não verificado:** publicar de verdade no Instagram (não há conta Business nem token neste ambiente: o cliente HTTP
  e os dois passos da API foram verificados contra simulações), a leitura real do perfil e dos posts, e a migração
  `0011` no Supabase.

### AgentOS: validação, criativos e calendário — fase 6 (10/10/2026)
Escopo: prospecção do Brasil inteiro, prova de que a autonomia máxima do Vendedor é autônoma, construtor Claude Code
no Agente 5, criativos feitos em código (imagem e vídeo) e calendário editorial com agendamento. Testes: `npm test`
(567), `tsc`, `lint` e `build` limpos. Migrações novas: `0012_prospeccao.sql` e `0013_criativos.sql` (já no
`setup-producao.sql` e no verificador). Passo a passo de uso em [`docs/ENTREGA_LOCAL.md`](docs/ENTREGA_LOCAL.md).

- **Agente 2 — varredura do Brasil e "Lista de prospecção".** Varredura contínua nicho × cidade (112 cidades: as 27 capitais e as grandes,
  capitais primeiro), só empresas **sem site**, ativa e com telefone; registra a cobertura em
  `prospect_coverage` e respeita os tetos diários. Desligada por padrão (cada busca ao Google é paga; "todo o Brasil"
  não cabe numa execução — ver `docs/PROSPECCAO_GOOGLE.md`, que também documenta o **risco dos Termos do Google
  Maps Platform** (só o `place_id` pode ser guardado sem prazo) e uma proposta de mínimo a guardar, **que depende de
  uma decisão sua**). Tela `/prospeccao` (nome, telefone, Instagram só quando achado, link do Maps, cobertura) e
  exportação CSV (`;`, BOM, fórmula neutralizada).
- **Agente 4 — autonomia máxima provada.** `tests/funil-autonomia.test.ts` roda, em modo automático e com o WhatsApp
  simulado: o relógio dispara a prospecção; dossiê; abordagem, resposta e marcação de reunião **sem nenhum pedido de
  aprovação**; prévia do site; e prova que (a) a única mensagem ao seu WhatsApp vinda do Vendedor é a da reunião (mais o
  aviso da prévia, que é do Agente 5), (b) mídia, mensagem vaga e dúvida fora do roteiro vão **só ao painel e ao sino**,
  (c) "pare" bloqueia na entrada **antes de qualquer modelo** (com um modelo configurado, nenhuma chamada saiu), (d) o
  interruptor geral para tudo e (e) os Agentes 6 e 7, em automático, **só propõem**: nenhuma escrita foi ao Instagram,
  nenhuma campanha ativou, nenhuma mídia foi servida de fora. As travas (política de envio, janela, teto, bloqueio) não
  são permissão e continuam valendo.
- **Agente 5 — construtor Claude Code, ao lado do gerador por modelos** (config "Quem escreve a página"; padrão:
  modelos). O Claude Code roda como `claude -p --restricted --strict-mcp-config --permission-mode dontAsk --tools
  Read,Write,Edit,Glob,Grep --max-budget-usd …` numa pasta isolada (`.data/site-work/<build>/`) com o perfil comprovado,
  as regras e as **skills de design fixadas**; sem Bash, sem internet, sem MCP, com o ambiente **sem as chaves do CRM**.
  **A mesma verificação** (estática + navegador) vale; se reprovar, ele recebe a lista exata do que falhou, até esgotar as
  rodadas, o prazo ou o teto de gasto (por prévia, US$ 1,50 por padrão); se falhar, a prévia sai pelo gerador por
  modelos e o motivo fica registrado. Skills fixadas por commit e SHA-256 em `docs/SITES_SKILLS.lock.json` (emil-design-eng,
  emil-animate, impeccable, taste-skill; só texto, nenhum script executado; `node scripts/instalar-skills-sites.mjs` recusa
  arquivo com hash diferente). **Verificado de verdade:** uma chamada real (empresa fictícia) devolveu uma página que
  passou na verificação em 1 rodada, 37 s, US$ 0,10. A verificação no navegador ganhou **contraste de texto** (≥ 3:1) —
  achado ao olhar a página que o Claude Code escreveu.
- **Criativos da própria empresa, em código** (`src/services/creatives/`, skill de projeto
  `.claude/skills/criativos/SKILL.md`): HTML/SVG renderizado em PNG pelo Chrome/Edge headless (Feed 1080×1350, Stories
  1080×1920, anúncio 1080×1080) e **vídeo como motion graphics** (Reels 1080×1920: cenas em PNG → ffmpeg com zoom lento e
  transições, H.264 yuv420p, áudio mudo, ~9,5 s). Sem API paga, sem foto, sem pessoa, sem marca de terceiros. Três
  composições ("Outro visual" troca). Verificação: só o texto que a empresa já disse, sem script/imagem/link/recurso
  externo, tamanho exato, texto dentro da margem de segurança do app (Stories/Reels deixam topo e rodapé livres),
  contraste, PNG de verdade, `ffprobe` (codec, dimensões, fps, duração, áudio, peso) e decodificação completa. Opcional:
  o Claude Code escreve a arte livre (imagens), com a mesma verificação e queda para o modelo. **Só é servido de fora
  depois de aprovado** (`/midia/<token>/<arquivo>`, token de 192 bits, 404 antes do clique e depois do prazo, com Range
  para vídeo).
- **Agente 6 — a campanha nasce com a imagem** (1080×1080, "pendente"): **aprovar a imagem é um clique, ativar a
  campanha é outro**, dentro dos tetos; com imagem, a campanha **só ativa com a imagem aprovada e íntegra** (o servidor
  confere o hash do arquivo). Campanhas antigas, sem imagem, não são afetadas.
- **Agente 7 — calendário editorial** (Feed, Reels, Stories; padrão 3/1/2 por semana, 7 dias à frente, horários 12h/18h/9h
  em Brasília; um post — mesmo recusado ou expirado — cobre a vaga do seu dia). Cada post nasce com a arte; **"Aprovar e
  publicar"** sai agora e **"Aprovar e agendar"** sai na hora marcada, **item a item, nunca em lote** (não existe ação
  que receba vários). O **publicador agendado** (`publishDueScheduled`, chamado só pelo runner, só com o agente liberado)
  reconfere tudo antes de sair: legenda nas barreiras, mídia íntegra e com hospedagem, resumo (SHA-256) do que você
  aprovou, janela de atraso (3 h; passou, avisa em vez de publicar fora de hora) e a **cota diária da API**
  (`content_publishing_limit`); reivindica o post de forma atômica (duas rodadas, uma publicação). Reels esperam o vídeo
  ficar `FINISHED`; erro ou demora **não** são incerteza (nada foi publicado); só o timeout da publicação em si é incerto.
  Sem `PUBLIC_BASE_URL` https (ou túnel) o post fica **"sem hospedagem"**: dá para revisar e aprovar a arte, não publicar.
- **Lacunas de fases anteriores achadas e corrigidas:** `expireStalePosts`, `expireStaleCampaigns` e
  `reconcileStuckPublishing` existiam mas **ninguém as chamava** (proposta nunca expirava sozinha; post preso em
  "publicando" nunca virava incerto). Agora o runner as chama, e as linhas gravadas antes da fase 6 (post sem formato,
  campanha sem imagem) são completadas na leitura.
- **Decisões abertas para você:** (1) o aviso "prévia pronta" também vai ao seu WhatsApp (é do Agente 5; a única
  interrupção do **Vendedor** é a reunião) — se quiser só sino, é desligar `queuePreviewNotice`; (2) o que guardar do
  Google Places (`docs/PROSPECCAO_GOOGLE.md`); (3) a fonte de demonstração gera leads que o envio e o site recusam de
  propósito, então o funil de teste usa um lead criado como o Agente 2 criaria com dado real.
- **Não verificado:** publicar de verdade no Instagram (feed, Reels, Stories e a cota: não há conta Business nem token
  aqui; o cliente HTTP, o polling do vídeo e os passos foram verificados contra simulações da API Graph); o envio real
  de WhatsApp (passo 3 da ativação é seu); a migração `0012`/`0013` no Supabase; o construtor Claude Code numa
  prévia real de cliente (só numa empresa fictícia); o Claude Code escrevendo **artes** (só o caminho simulado e o
  modelo foram exercitados com Chrome real); custos reais de uso contínuo.
- **Verificado no app real (preview na porta 3100, com Chrome e ffmpeg desta máquina):** o runner gerou 4 propostas com
  arte (3 imagens, 1 Reels de 9,5 s, 37 verificações), o calendário aparece com as vagas, o vídeo toca no painel, a
  campanha proposta veio com a imagem e o botão "Ativar" ficou desligado até aprovar a imagem; sem rolagem lateral no
  celular. Os dados de teste foram desfeitos (`.data/db.json` restaurado).

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
