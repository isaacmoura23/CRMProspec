# Auditoria funcional — ProspecAtlas

Verificação em 24/09/2026, horário de São Paulo. Análise do checkout atual, incluindo alterações locais preexistentes.

## Diagnóstico

O projeto compila e serve as páginas localmente. A operação completa está bloqueada por uma combinação de acesso restrito na publicação, configuração local incompleta, persistência parcial e funcionalidades anunciadas que ainda não executam a operação externa.

Não foi feita implantação nem alteração no código da aplicação. Este relatório separa fatos observados de riscos identificados por leitura do código.

## Validação executada

- `npm test`: 50 testes passaram.
- `npm run lint`: passou.
- `npm run typecheck`: passou.
- `npm run build`: passou.
- Build de produção iniciado localmente na porta 3100.
- 19 rotas autenticadas no modo demo retornaram HTTP 200, sem erro de servidor detectado no HTML: dashboard, prospectar, leads, pipeline, follow-ups, conversas, análises, automações, campanhas, propostas, clientes, relatórios, equipe, configurações, integrações, carreira, tarefas e um detalhe de lead e de campanha.
- `/login` respondeu 200; `/dashboard` e `/leads` sem sessão redirecionaram para `/login`.
- `https://prospecatlas.vercel.app` respondeu 302 para o SSO da Vercel, terminando no login da plataforma.
- Inspeção das variáveis locais sem exibir valores: Google Places configurado; Supabase, OpenAI, Resend, OAuth do Gmail, segredo de tokens e segredo do worker ausentes no `.env.local`.

Os testes HTTP verificam renderização, não cliques, hidratação, layout visual ou todos os fluxos de escrita. Os testes automatizados usam stubs e armazenamento temporário; não comprovam integrações reais. As variáveis e migrações da produção não foram verificadas. A chave do Google está presente, mas sua validade/cota não foi testada nesta auditoria.

## Problemas por prioridade

### 1. A publicação está protegida pelo login da Vercel — bloqueio confirmado

Visitantes sem acesso ao deployment não chegam sequer ao login do CRM. Isso explica o site não abrir para terceiros. Não é erro de build ou rota.

Correção: revisar a Deployment Protection quando a autenticação real e o armazenamento estiverem prontos. Não foi alterada a proteção, pois o histórico do projeto registra que ela foi ativada intencionalmente.

### 2. Persistência incompleta — crítico para uso na Vercel

`src/lib/store.ts` guarda o CRM em `.data/db.json` e em um objeto global do processo. Quando o filesystem não permite escrita, segue em memória. `saveDb()` notifica somente o sincronizador de leads.

O repositório remoto de leads cobre `app_leads`, `app_lead_analysis` e `app_lead_score_history`. Carreira e usuários têm repositórios próprios. Tarefas, propostas, campanhas comerciais, etapas, conversas, mensagens, configurações, regras de automação e webhooks continuam dependentes do snapshot.

Consequência: salvar na interface não garante persistência compartilhada entre instâncias ou sobrevivência a reinícios na hospedagem. Configurar Supabase resolve apenas as partes já migradas.

Correção: concluir a persistência do domínio comercial e confirmar escritas no banco antes de informar sucesso.

### 3. O ambiente local continua em modo demo

`src/lib/supabase-auth.ts` exige URL e anon key; `src/lib/supabase.ts` exige URL e uma chave. Essas variáveis não estão no `.env.local` examinado. `src/lib/auth.ts` então aceita sessão demo baseada no identificador de usuário, sem senha.

Correção: configurar Supabase, executar as migrações aplicáveis e verificar cadastro, confirmação, login, recuperação e persistência após reinício. O estado local não prova que a produção tenha a mesma configuração.

### 4. Conversas não envia mensagens reais — confirmado no código

`src/actions/conversations.ts:11`: `sendMessage()` apenas insere em `db.messages`, atualiza a conversa e registra atividade como mensagem enviada. Não chama WhatsApp, Gmail nem outro transporte. Recebimento é simulado em `simulateInbound()`.

Consequência: o operador pode interpretar o histórico como contato realizado, embora nada tenha sido entregue ao destinatário.

Correção: implementar transporte, recebimento, comprovante e erros de entrega; enquanto isso, identificar explicitamente a operação como simulação/registro local.

### 5. Integrações e convites prometem operações que não existem

- `src/app/(app)/integracoes/page.tsx`: WhatsApp Business, Gmail comercial, Google Calendar e n8n sempre recebem status desconectado; a tela orienta definir variáveis, mas isso não implementa os conectores. O webhook genérico existente não equivale a essas integrações completas.
- `src/features/team/team-view.tsx:94` anuncia convite por e-mail via Supabase Auth. `src/actions/management.ts:345` e `src/services/user-repository.ts:177` somente registram o convite no banco; não enviam e-mail.
- Falhas em `persistInvite()`, `persistMemberRole()` e `persistUserProfile()` são apenas registradas no console. A action pode concluir e a interface mostrar sucesso mesmo quando o banco recusou a escrita.

O Gmail do módulo Carreira é uma implementação separada; sua existência não conecta o inbox comercial.

### 6. Sincronização de leads pode produzir dados desatualizados ou perder alterações

Problemas identificados em `src/services/lead-repository.ts`:

- Carrega dados uma vez por instância, sem atualização das mudanças feitas por outras instâncias.
- Marca `__crmLeadsLoaded` antes de terminar a consulta. Requisições concorrentes podem seguir com o snapshot anterior.
- Sincroniza apenas leads com `updated_at` posterior ao último corte. Alterações de follow-up em `src/actions/tasks.ts` e de valor potencial em `createProposal()` não atualizam esse timestamp.
- Erros nas análises e no histórico são registrados, mas o corte de sincronização avança mesmo assim. O fallback de upsert individual também pode registrar erros e avançar o corte sem preservar corretamente todos os itens pendentes.
- Leituras remotas não têm paginação; bases acima do limite de resposta configurado no Supabase podem ficar incompletas.

São falhas de desenho/código; sua ocorrência no banco de produção não foi reproduzida nesta auditoria.

### 7. Prospecção depende da instância que iniciou o trabalho

`src/jobs/prospecting.ts` cria o job no snapshot e executa com `after()`. `src/actions/prospecting.ts` consulta o mesmo snapshot para informar progresso. O limite da rota é de 300 segundos.

`after()` mantém trabalho pós-resposta dentro do limite da plataforma, mas não oferece fila durável nem estado compartilhado. Outra instância pode não encontrar o job; uma interrupção não é retomada automaticamente. A interface trata job perdido e há expiração, mas isso não recupera o processamento.

Correção: persistir jobs, usar aquisição exclusiva, checkpoints e retomada, de forma semelhante à intenção da fila do módulo Carreira.

### 8. Permissões e organização não estão completas para operação multiempresa

Actions de leads e tarefas exigem sessão, mas não recusam o papel `viewer`. A autenticação sozinha permite alterações que um perfil somente de leitura não deveria fazer.

O store é global; as consultas comerciais usam `db.organization.id`, não o tenant resolvido individualmente pela sessão. O cliente administrativo usa service role. A aplicação comercial ainda precisa de autorização por operação e isolamento por organização antes de ser considerada multiempresa.

### 9. Carreira e IA têm dependências ausentes no ambiente examinado

- Sem `OPENAI_API_KEY`, análises e textos usam o motor determinístico existente. Isso não quebra a navegação, mas não entrega análise por LLM.
- Sem Resend/OAuth, candidaturas não têm um canal de envio configurado; vagas sem e-mail seguem o caminho de ação manual previsto pelo produto.
- Sem `CRON_SECRET` ou `CAREER_WORKER_SECRET`, `/api/career/worker` recusa chamadas. A navegação ainda pode acordar o worker, mas não substitui execução autônoma confiável.
- OCR de PDFs digitalizados e Adzuna dependem de configuração adicional. Remotive e PDFs textuais têm caminhos que não exigem essas chaves.

## Ordem recomendada de correção

1. Definir o ambiente de uso e configurar autenticação real e banco; conferir migrações e URLs de callback.
2. Migrar o restante do CRM, corrigir sincronização e validar recuperação após reinício e acesso por duas instâncias.
3. Aplicar permissões por papel e isolamento por organização.
4. Tornar os jobs de prospecção duráveis e configurar o worker de Carreira.
5. Implementar os canais e convites reais; corrigir textos/status que hoje sugerem envio ou conexão inexistentes.
6. Executar testes ponta a ponta de cadastro, criação/prospecção, edição, tarefa, proposta, envio e retorno de mensagem.
7. Com esses pontos verificados, revisar a proteção da publicação e testar acesso externo.

As alterações locais preexistentes foram preservadas. O código não foi corrigido nesta etapa de diagnóstico.
