# Entrega local do AgentOS: build, checklist e o que é seu

Tudo roda na sua máquina (Windows), sem VPS, com o Supabase gratuito opcional. Este arquivo é o roteiro para colocar o
sistema de pé, ligar cada peça com segurança e saber o que **não** foi verificado ao vivo. O estado detalhado de cada
agente está em [`ESTADO.md`](../ESTADO.md).

## 1. Subir o sistema

```bash
npm install
npm run build
npm start          # http://localhost:3000 — o runner dos agentes sobe junto
```

O computador precisa ficar ligado e sem suspender enquanto os agentes trabalham (e, para publicar o que você agendou, na hora
marcada). Sem nenhuma chave o sistema sobe em **modo demo**: dados fictícios, tudo marcado como demonstração.

Conferência rápida antes de confiar: `npm test`, `npm run typecheck`, `npm run lint` e `npm run build` devem passar limpos.

## 2. O que precisa existir na máquina

| Peça | Para quê | Como conferir |
|---|---|---|
| Chrome ou Edge | verificar sites e gerar as artes (PNG) | a tela de cada agente avisa se não achou; `CHROME_PATH` aponta o caminho |
| `ffmpeg` e `ffprobe` | só o vídeo dos Reels | `ffmpeg -version`; `FFMPEG_PATH` aponta o executável |
| Claude Code (`claude`) | só se você escolher "Claude Code" como construtor | `claude --version`; `CLAUDE_BIN` aponta o executável |
| Skills de design | o construtor Claude Code (sites e artes) | `node scripts/instalar-skills-sites.mjs` (fixadas por hash; recusa arquivo alterado) |

## 3. Ligar por degraus (cada um é um passo seu)

1. **Chaves** (sempre pelo terminal, nunca coladas em conversa): `node scripts/set-google-key.mjs`,
   `node scripts/set-anthropic-key.mjs`, `node scripts/set-supabase.mjs`, `node scripts/set-instagram-token.mjs`,
   `node scripts/set-whatsapp-gateway.mjs`. Reinicie o servidor depois.
2. **Supabase (opcional)**: rode no SQL Editor `database/migrations/0005_agentes.sql` até `0013_criativos.sql` (ou o
   `database/setup-producao.sql` inteiro) e confira com `node scripts/verificar-supabase.mjs`.
3. **WhatsApp**: siga `docs/WHATSAPP_LOCAL.md`. O envio é ativado em degraus (simulado → só o seu número → real). **O envio
   real é decisão sua e nunca é ligado pelo sistema.**
4. **Hospedagem da mídia (Instagram)**: defina `PUBLIC_BASE_URL` com um endereço https que chegue ao seu servidor (um túnel seu
   serve). O Instagram busca a imagem/vídeo desse endereço; sem ele, os posts ficam "sem hospedagem" (você revisa, não publica).
5. **Instagram**: conta Business ligada a uma página do Facebook, ID e token de longa duração pelo script acima.
6. **Anúncios**: o provedor é "manual": você cria a campanha na plataforma e o CRM guarda o controle, os tetos e os relatórios.
   Defina os tetos diário e mensal antes de ativar qualquer campanha.

## 4. Modos dos agentes e o que cada um faz sozinho

- **Pausado**: nada roda (e o interruptor geral para todos).
- **Em aprovação**: o que o agente decide iniciar vira um pedido e só roda depois do seu clique.
- **Automático**: roda sem pedir. Vale para o **Vendedor** (abordar, responder, marcar reunião, dentro da política de envio) e
  para os demais. **Os Agentes 6 e 7 só propõem, em qualquer modo**: publicar, agendar, ativar e mexer em orçamento são sempre
  um clique seu.

A única mensagem que o **Vendedor** manda ao seu WhatsApp é a de reunião marcada. O Programador de Sites também avisa quando a
prévia fica pronta. Qualquer dúvida do Vendedor (mídia, mensagem vaga, assunto fora do roteiro) aparece só no painel e no sino.

## 5. Checklist de aceite (marque ao verificar de verdade)

- [ ] `npm test` (567), `typecheck`, `lint` e `build` passam.
- [ ] `/agentes` mostra o batimento do runner; o interruptor geral para tudo.
- [ ] `/prospeccao` lista empresas sem site; "Exportar CSV" baixa o arquivo; ligar a varredura só depois de decidir sobre os
      termos do Google (`docs/PROSPECCAO_GOOGLE.md`).
- [ ] Programador de Sites: a prévia só nasce com interesse explícito + reunião; abre em `/previa/<token>`; as verificações aparecem.
- [ ] Mídias Sociais: o calendário mostra as vagas; cada post tem arte (imagem ou vídeo que toca); "Outro visual" troca;
      sem `PUBLIC_BASE_URL` os botões de aprovar ficam desligados e dizem por quê.
- [ ] Gestor de Tráfego: a campanha proposta traz a imagem; "Ativar" fica desligado até aprovar a imagem; os tetos barram o que passa deles.
- [ ] Com o Instagram configurado e **um post de teste seu**: "Aprovar e agendar" para daqui a 10 minutos; confira que saiu na hora
      certa, uma vez só, e que "Cancelar agendamento" antes da hora o devolve a pendente.
- [ ] Com o gateway em modo de teste, o funil simulado: abordagem → resposta → reunião → aviso no seu número (passo 2 da ativação).

## 6. O que **não** foi verificado ao vivo (e por quê)

- Publicar de verdade no Instagram (Feed, Reels e Stories) e a cota diária da API: não há conta Business nem token no ambiente
  de desenvolvimento. O cliente HTTP, o polling do vídeo e a cota foram verificados contra simulações da API Graph.
- Envio real de WhatsApp (passo 3 da ativação).
- Migrações `0012` e `0013` no Supabase (exigem um Postgres real).
- O construtor Claude Code numa prévia de cliente real (foi exercitado com uma empresa fictícia: 1 rodada, 37 s, US$ 0,10) e
  escrevendo artes (o caminho foi exercitado só com simulação; os modelos de arte, com Chrome e ffmpeg reais).
- Custo de uso contínuo do Claude Code (cada prévia tem teto, padrão US$ 1,50; cada arte, US$ 0,50).
- Ligar a hospedagem pública: o endereço público que o Instagram vai buscar depende do seu túnel ou domínio.

## 7. Segurança em uma página

- Nenhum agente recebe ferramenta que mexa fora do CRM (`src/agents/tools.ts`); um teste confere a lista e o código.
- Publicar, agendar, aprovar arte e ativar campanha são ações de botão, com `owner`/`admin`. O publicador agendado só publica o que
  você aprovou, depois de reconferir tudo, e só com o agente liberado.
- A mídia só tem endereço público depois do seu clique (token de 192 bits; antes e depois do prazo, 404).
- O Claude Code roda sem Bash, sem internet, sem MCP e **sem as chaves do CRM** no ambiente; o texto que ele lê (perfil do
  cliente) é tratado como dado, não como instrução.
- Skills de terceiros: só texto, fixadas por commit e SHA-256; nada é executado.
- Nunca cole chaves em conversa: use os scripts `scripts/set-*.mjs`.
