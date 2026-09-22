# Prompt de implementação — Carreira no ProspecAtlas

Implemente no projeto existente uma nova página **Carreira**, na rota `/carreira`, para receber currículos em PDF, analisar conteúdo e links, sugerir correções, encontrar vagas compatíveis, realizar candidaturas em massa e acompanhar cada candidatura. Entregue frontend e backend funcionais, preservando os módulos atuais e as alterações locais existentes.

## 1. Contexto verificado do repositório

- Stack declarada: Next.js 16.3.1, React 19.2.8, TypeScript, Tailwind CSS 4, Radix UI, Lucide e Zod 4.
- As páginas ficam em `src/app/(app)`, os componentes de domínio em `src/features`, as Server Actions em `src/actions`, a IA em `src/ai`, os serviços em `src/services` e os provedores em `src/providers`.
- Reaproveite `PageHeader`, cards, tabelas, tabs, dialogs, toasts e os tokens de `src/app/globals.css`: fundo claro, menu escuro e destaque verde. Interface em português brasileiro, responsiva e acessível.
- Adicione a navegação em `src/components/layout/sidebar.tsx` e o atalho em `src/components/layout/command-palette.tsx`; confira também a navegação móvel.
- `src/ai/client.ts` oferece `llmComplete`; os prompts e schemas já têm estrutura própria. Reaproveite essa organização com schemas específicos de carreira.
- `src/lib/store.ts` usa snapshot JSON/memória. `src/services/lead-repository.ts` espelha somente parte do domínio no Supabase. Não considere essa arquitetura uma persistência pronta para currículos e filas de produção.
- `src/lib/auth.ts` e `src/actions/auth.ts` ainda implementam sessão demo por ID de usuário; a configuração de Supabase não transforma isso automaticamente em autenticação real.
- `src/actions/conversations.ts` grava mensagens localmente: não envia e-mails. A integração Gmail em `/integracoes` ainda não está implementada. Resend também precisa ser integrado.
- Os provedores atuais buscam empresas no Google Places ou em um diretório demo; não encontram vagas de emprego. Crie provedores de vagas separados.
- `src/jobs/prospecting.ts` usa `after()` e progresso por etapas. Reaproveite a experiência visual, mas implemente fila durável para análise, busca recorrente e envio de candidaturas.
- Eventos e automações atuais são centrados em leads. Não trate candidatos como leads nem envie dados de currículos aos webhooks comerciais existentes por padrão.
- As migrações `0001_initial.sql` e `0002_leads_hibrido.sql` têm modelos diferentes, incluindo IDs UUID e text. Verifique qual esquema está instalado e forneça migração compatível; não suponha que executar uma nova migração completa automaticamente as anteriores.

Leia `AGENTS.md` e os guias relevantes em `node_modules/next/dist/docs/` antes de programar. A documentação local de Server Actions informa limite padrão de corpo de 1 MB, e `after()` continua sujeito ao tempo máximo da plataforma. Considere esses limites na arquitetura de uploads e processamento.

## 2. Página e fluxo do usuário

Crie `src/app/(app)/carreira/page.tsx` com quatro abas:

1. **Meu currículo:** botão “Enviar currículo PDF”, arrastar e soltar, prévia, versões, perfil profissional extraído e preferências editáveis.
2. **Análise e melhorias:** diagnóstico, critérios de avaliação, links inspecionados, problemas priorizados e sugestões com antes/depois.
3. **Vagas compatíveis:** busca, filtros, justificativa de compatibilidade, seleção múltipla, prévia das mensagens e ação “Iniciar candidaturas”.
4. **Minhas candidaturas:** histórico, filtros, indicadores, detalhes de cada envio e controles de campanhas.

Fluxo: enviar PDF → extrair perfil → analisar currículo e links → apresentar ajustes → definir preferências → encontrar vagas → revisar campanha → executar candidaturas → acompanhar resultados.

Mostre estados vazios, carregamento, progresso medido, falhas recuperáveis e configuração incompleta. Sem integrações, a demonstração deve ser claramente identificada e nunca efetuar envios reais.

## 3. Recebimento e análise do PDF

- Aceite PDF com limite inicial de produto de 10 MB, validado no servidor por tamanho, assinatura do arquivo e tipo; não confie apenas na extensão ou no MIME do navegador.
- Use upload direto para armazenamento privado com autorização temporária e validação posterior. Não encaminhe arquivos grandes por Server Actions sem avaliar também o limite da hospedagem.
- Armazene original, hash, proprietário, organização, tamanho, nome, data e versão. Acesso somente ao titular e a compartilhamentos explicitamente autorizados.
- Extraia texto por página e URLs tanto do texto quanto das anotações de hyperlink do PDF. Preserve a referência da página para explicar cada conclusão.
- Para PDFs digitalizados, implemente OCR em worker compatível com o deploy; mostre indisponibilidade caso o serviço não esteja configurado. Trate PDF corrompido, protegido por senha, sem texto, com extração parcial ou excesso de páginas.
- Limite tempo, memória, páginas e tamanho de saída do parser/OCR. Não execute JavaScript, arquivos incorporados ou ações do PDF.
- Extraia dados profissionais: nome, contato, localização, resumo, experiências, datas, formação, habilidades, idiomas, certificados, projetos e links. Permita corrigir a extração antes da candidatura.
- Analise clareza, organização, ortografia, consistência de datas, descrição de resultados, adequação ao cargo e legibilidade para sistemas de triagem ATS. Quando avaliar layout, use renderização das páginas; não deduza toda a aparência apenas do texto extraído.
- Apresente score explicável de 0 a 100 com pesos publicados, evidências e critérios não avaliados. Separe qualidade geral do currículo de aderência a uma vaga. Não apresente a nota como certificação universal ou probabilidade de contratação.
- Contextualize as recomendações por profissão, senioridade, país e vagas consultadas. Não invente um “padrão de mercado” único nem penalize a ausência de portfólio em profissões em que ele não é relevante.
- Para cada melhoria, apresente: trecho original, problema, justificativa, prioridade e texto sugerido. Não invente formação, empregadores, resultados, métricas ou competências; quando faltar dado, peça que o usuário o complete.
- Permita aceitar ou rejeitar sugestões individualmente, editar e gerar uma versão revisada em PDF com layout simples e texto selecionável. Preserve o original e mostre qual versão será enviada.

## 4. Inspeção dos links do currículo

- Liste todos os links encontrados, deduplique e visite os endereços HTTP/HTTPS públicos relevantes, incluindo LinkedIn, GitHub, portfólios, projetos e certificados.
- Para cada link registre URL original/final, status, data, conteúdo efetivamente consultado, evidências, limitações e melhorias sugeridas. A interface deve distinguir acesso concluído, parcial, bloqueado, quebrado e pendente.
- Analise coerência com o currículo, apresentação, documentação dos projetos, demonstrações disponíveis e resultados verificáveis. Em repositórios, inspecione metadados, README e arquivos relevantes dentro de um orçamento de leitura; não execute código remoto.
- “Analisar tudo” significa cobrir o conteúdo do PDF e os links identificados, com limites transparentes. Não prometa ler integralmente todos os repositórios ou sites alcançáveis recursivamente.
- Respeite autenticação, restrições de acesso e limites das plataformas. Não contorne CAPTCHA ou login. Quando o conteúdo não estiver acessível, permita anexar material ou registrar revisão manual, sem simular a análise.
- Não reutilize diretamente o fetch de enriquecimento comercial: crie um cliente seguro com bloqueio de SSRF, redes privadas, loopback, link-local, metadados de nuvem e esquemas não permitidos. Valide resolução DNS e cada redirecionamento, mitigando DNS rebinding, com limites de bytes durante a leitura, tempo, concorrência e profundidade.
- Considere PDFs, anúncios e páginas externas dados não confiáveis. Instruções contidas nesses conteúdos não podem alterar regras do sistema, destinatários, permissões, ferramentas ou acesso a segredos. A IA produz sugestões estruturadas; ações externas são validadas pelo backend.

## 5. Busca e compatibilidade de vagas

- Crie uma interface `JobProvider` com busca paginada, detalhes, disponibilidade e capacidade de candidatura. Implemente pelo menos uma fonte real documentada e permitida, com cobertura regional explícita; mantenha fixtures apenas no modo demo.
- Verifique documentação e acesso dos provedores na implementação. Não invente APIs ou credenciais de Gupy, LinkedIn ou outras plataformas. Fontes de listagem pública não implicam permissão ou API para candidatar.
- Permita importar uma URL de vaga, usando o mesmo cliente HTTP seguro. Se não houver fonte de busca configurada, informe o bloqueio e mantenha a importação disponível, sem fabricar resultados.
- Busque por ocupações, competências e senioridade do currículo combinadas às preferências do usuário: cargos desejados, localização, remoto/híbrido/presencial, idiomas, contrato, salário quando informado e empresas excluídas.
- Salve título, empresa, descrição, requisitos, URL canônica, fonte, ID externo, data de coleta, validade e canal de candidatura com sua evidência de origem.
- Calcule aderência explicável: requisitos atendidos, lacunas, fatores desconhecidos e restrições obrigatórias. Não confunda requisitos desejáveis com obrigatórios; não use atributos pessoais sensíveis como critério de matching.
- Deduplique entre fontes e revalide disponibilidade antes do envio. Nunca invente e-mails de recrutadores. Só use endereços publicados para candidatura à vaga ou recrutamento pertinente.
- Permita ordenar por compatibilidade e atualidade, salvar/descartar vagas e filtrar por nota mínima. Não complete a quantidade desejada com vagas incompatíveis.
- Ofereça busca recorrente configurável com próxima execução, pausa, cancelamento e limites de consumo. Ela deve funcionar com o navegador fechado, por agendador e fila persistidos.

## 6. Campanhas e candidaturas em massa

- O usuário pode selecionar várias vagas ou habilitar uma campanha recorrente com cargos, filtros, nota mínima, versão do currículo, canal, limite diário, duração e modelo de mensagem.
- Antes da ativação, mostre o resumo concreto e exemplos das mensagens. Essa ativação autoriza os envios dentro dos parâmetros escolhidos, sem exigir confirmação repetida para cada vaga. Alterações materiais de escopo exigem atualização explícita da campanha.
- Faça um envio individual por candidatura; não exponha várias empresas em To/CC/BCC. Priorize relevância e respeite cotas e políticas dos serviços. Não implemente evasão de bloqueios ou rotação de contas para exceder limites.
- Implemente pausa, retomada, cancelamento, progresso real e relatório de falhas. Pausar/cancelar deve impedir novos envios já enfileirados, verificando o estado novamente antes de cada chamada externa.
- Use fila durável com jobs, tentativas, `next_run_at`, locks/leases, backoff com jitter, tratamento de 429 e falhas transitórias, concorrência limitada e recuperação após reinício. Não use apenas timers em memória ou `after()` para sustentar a campanha.
- Persistir candidatura e intenção de envio antes da chamada externa. Use restrição única por candidato e vaga canônica para evitar duplicação entre campanhas e canais. Fixe currículo e mensagem por tentativa lógica, e reutilize a mesma chave de idempotência nos retries.
- Em timeout após possível aceite pelo provedor, registre resultado incerto e reconcilie antes de reenviar. Não prometa entrega exatamente uma vez sem mecanismos que a sustentem.
- Interrompa tentativas para destinatários inválidos, reclamações ou bloqueios permanentes; mostre o motivo. Candidaturas concluídas e vagas encerradas não entram novamente na fila automaticamente.
- Para plataformas, implemente conectores permitidos com credenciais/autorização apropriadas e comprovante de submissão. Na ausência de integração, forneça link, currículo e respostas preparadas, marcando “Ação manual necessária”. Abrir a página ou preparar formulário não significa candidatura enviada.
- Não responda perguntas de elegibilidade, disponibilidade ou condições contratuais com informações inventadas; use perfil confirmado e sinalize pendências.

## 7. Resend e Gmail

### Resend como canal principal

Integre o SDK/API Resend exclusivamente no servidor. Use `RESEND_API_KEY`, `RESEND_FROM_EMAIL` e `RESEND_WEBHOOK_SECRET` em variáveis de ambiente. A chave compartilhada anteriormente na conversa está exposta: não a copie para código, documentação ou testes; solicite sua substituição na configuração operacional.

Envie cada candidatura com remetente de domínio verificado, destinatário individual, assunto específico, texto simples, HTML seguro, PDF anexado e `reply_to` com o e-mail confirmado do candidato. Não use `@gmail.com` como remetente Resend, pois o domínio precisa pertencer ao operador. Configure SPF/DKIM e documente DMARC. Veja [domínios verificados do Resend](https://resend.com/docs/dashboard/domains/introduction).

**Envio em massa com PDF deve usar fila de envios individuais:** a documentação consultada da [API Batch](https://resend.com/docs/api-reference/emails/send-batch-emails) informa que anexos não são suportados. Revalide isso durante a implementação. A [idempotência do Resend](https://resend.com/docs/dashboard/emails/idempotency-keys) tem janela de 24 horas; mantenha também deduplicação persistente própria além dessa janela.

Registre ID do provedor, destinatário, currículo, conteúdo enviado e tentativas. Implemente webhook com verificação de assinatura sobre corpo original, proteção contra replay e eventos duplicados/fora de ordem. Diferencie aceite da API, envio, entrega, atraso, bounce e reclamação. Entrega não comprova leitura ou contratação.

### Envio pela conta Gmail

Resend pode entregar a destinatários Gmail, mas não equivale a enviar pela conta Gmail do candidato. Implemente um canal separado, opcional, usando OAuth e Gmail API, com escopos mínimos, tokens protegidos no servidor, revogação e tratamento de expiração. Consulte o [guia oficial de envio do Gmail](https://developers.google.com/workspace/gmail/api/guides/sending).

No Gmail, envie mensagem MIME com o PDF anexado, usando a conta autenticada e registrando o ID retornado. Não envie a mesma candidatura também pelo Resend. Geração e cópia de texto devem funcionar mesmo sem Gmail conectado; envio exige integração funcional.

Não afirme que respostas ao `reply_to` Gmail serão capturadas pelo webhook Resend. Sincronização de respostas Gmail exige integração e permissões específicas; sem ela, disponibilize atualização manual do status de seleção.

## 8. Texto personalizado de candidatura

Gere assunto e mensagem usando somente currículo confirmado, vaga e evidências consultadas. Personalize empresa, cargo e duas ou três correspondências reais. Use linguagem profissional, natural e concisa, no idioma da vaga, sem elogios genéricos nem alegações inventadas. Permita revisar assunto, corpo, assinatura e anexo antes da campanha.

Modelo base editável, válido para Gmail e Resend:

> **Assunto:** Candidatura para {{cargo}} — {{nome}}
>
> Olá, equipe de recrutamento da {{empresa}}.
>
> Gostaria de me candidatar à vaga de {{cargo}}, divulgada em {{fonte}}. Minha experiência com {{competencia_relevante}} está alinhada ao trabalho descrito em {{responsabilidade_da_vaga}}.
>
> Em {{experiencia_ou_projeto_real}}, desenvolvi {{atividade_comprovada}}, com {{resultado_documentado}}. Também tenho experiência em {{segunda_competencia_confirmada}}, mencionada nos requisitos da oportunidade.
>
> Encaminho meu currículo em anexo e fico à disposição para conversar sobre como posso contribuir com a equipe. Meu {{portfolio_ou_perfil}} está disponível em {{link_verificado}}.
>
> Obrigado pela atenção,
> {{nome}}
> {{telefone_opcional}} · {{email}}

Omita frases sem dados suficientes e reescreva naturalmente. Não deixe placeholders na mensagem final. Se o currículo não tiver resultado quantificado, descreva a atividade comprovada sem fabricar números. Escape HTML e impeça injeção em cabeçalhos.

## 9. Acompanhamento e dados

Na aba “Minhas candidaturas”, apresente empresa, vaga, compatibilidade, origem, destino, canal, data, versão do currículo e detalhes da mensagem. Ofereça busca, filtros, timeline e exportação CSV com proteção contra injeção de fórmulas.

Separe três estados independentes:

- **Processamento:** rascunho, pendente, enfileirada, processando, ação manual necessária, resultado incerto, falhou, cancelada, concluída.
- **E-mail:** aceito pelo provedor, enviado, entregue, atrasado, devolvido ou reclamação, conforme evidência disponível.
- **Processo seletivo:** candidatura registrada, resposta recebida, entrevista, proposta, contratado, rejeitado ou retirada. Atualização manual deve ser identificada como tal.

Cada candidatura deve guardar histórico append-only de eventos, ID/comprovante do provedor, origem do status e horário. Mostre os totais sem somar retries como novas candidaturas.

Crie tabelas/migrações e tipos para perfis profissionais, versões de currículos, análises, links analisados, preferências, vagas, matches, campanhas, candidaturas, tentativas, eventos, jobs e conexões de provedores. Toda relação deve respeitar proprietário/organização. Persista a versão exata do currículo, do anúncio, do score e da mensagem usados no envio.

Antes de habilitar dados pessoais e envios em produção, implemente autenticação real e autorização por titular; RLS e políticas de Storage devem impedir acesso entre usuários, inclusive da mesma organização quando não houver compartilhamento. Service role deve ficar restrita a workers/backend com escopo explicitamente validado; nunca confiar no `user_id` ou `organization_id` enviado pelo cliente.

Currículos e tokens não devem ser públicos, aparecer em logs nem ser anexados automaticamente aos webhooks comerciais. Use links temporários para downloads, controles de exclusão e retenção, e explique ao usuário quais provedores processam o currículo. Excluir um perfil deve cancelar jobs pendentes e remover seus arquivos conforme a política definida.

## 10. Organização sugerida e entrega

Distribua o código, conforme as convenções existentes, em:

- `src/features/career/`: telas, upload, análise, vagas e histórico.
- `src/actions/career.ts`: ações validadas e autenticadas.
- `src/services/career/`: análise, matching, candidaturas, repositórios e fila.
- `src/providers/jobs/` e `src/providers/email/`: interfaces e implementações reais.
- `src/ai/prompts/`: análise de currículo e mensagem de candidatura, com schemas correspondentes.
- `src/app/api/webhooks/resend/route.ts`: eventos de entrega.
- Rotas necessárias para OAuth, upload e execução autenticada de workers.
- `database/migrations/`: migrações compatíveis com o estado real do banco.

Documente variáveis de ambiente sem valores secretos: Resend, Supabase, IA, fonte de vagas, OCR, OAuth Gmail e infraestrutura de fila/agendamento conforme a implementação escolhida. Não grave credenciais no snapshot JSON nem use prefixo `NEXT_PUBLIC_` para segredos.

Implemente em etapas executáveis: persistência/autenticação → upload/análise → busca/matching → Resend/fila → histórico/webhooks → Gmail/conectores de plataformas → recorrência. Mantenha o fluxo visível e informe dependências externas ainda não configuradas; não declare uma integração pronta com um botão sem backend.

Valide com testes relevantes: PDF textual/digitalizado/inválido; hyperlinks de anotação; links bloqueados e SSRF; sugestões sem invenções; isolamento entre titulares; deduplicação entre fontes/campanhas/canais; duas execuções concorrentes; reinício de worker; pausa/cancelamento; timeout após aceite; webhook falso, repetido e fora de ordem; falha por quota; vaga encerrada; ausência de credenciais; Gmail desconectado. Use mocks e destinatários de teste, sem disparar candidaturas para empresas durante a validação.

Execute lint, verificação de tipos e build, separando falhas preexistentes das introduzidas. Verifique o fluxo responsivo e por teclado. Ao concluir, relate arquivos alterados, migrações, testes executados e configurações necessárias. Critério de sucesso: o usuário consegue subir um PDF, entender correções com evidências, encontrar vagas reais compatíveis, iniciar uma campanha e identificar exatamente quais candidaturas foram enviadas, por qual canal e com qual comprovante.
