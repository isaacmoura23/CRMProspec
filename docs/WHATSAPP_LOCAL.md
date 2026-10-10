# WhatsApp local — gateway e conexão

Guia do gateway de WhatsApp do AgentOS rodando no seu computador. Cobre a fase
3a: conectar o número dedicado e entregar o estado da conexão ao CRM. **Nenhuma
mensagem é enviada ainda**: o envio real depende da política de envio (limites,
janela de horário, opt-out, aprovação), que é a fase seguinte.

> **Isto não é a API oficial da Meta.** O gateway usa a biblioteca
> [Baileys](https://github.com/WhiskeySockets/Baileys), que fala o protocolo do
> WhatsApp Web. A Meta não dá suporte e pode **restringir ou banir** o número que
> automatiza mensagens, principalmente para quem não é seu contato. Nada aqui
> tenta contornar bloqueios: se o WhatsApp encerrar a sessão, ela fica em
> "Precisa reconectar" até alguém ler o QR Code de novo.

## Como as peças se falam

```
celular (WhatsApp) ──QR──▶ gateway (npm run gateway, porta 3200)
                              │  sessão do WhatsApp + caixa de saída: gateway/.data/gateway.db (SQLite)
   CRM (npm start, 3000) ◀────┤  webhook assinado (HMAC) com o estado da conexão
   /agentes/vendedor ─────────▶  HTTP + token: conectar, desconectar, sair, consultar
```

- O gateway é um **processo à parte**, sempre ligado. O CRM nunca fala com o
  WhatsApp diretamente.
- O gateway **não acessa o Supabase** nem o banco do CRM. Guarda a sessão e a
  caixa de saída num SQLite próprio. Motivo: o plano gratuito do Supabase pausa
  por inatividade, e perder a sessão derruba o número e exige novo QR.
- Cada mudança de estado vira um evento na **caixa de saída**, gravado antes de
  qualquer tentativa de envio. Com o CRM fora do ar, os eventos esperam e saem,
  na ordem, quando ele volta. O CRM deduplica pelo id do evento.
- Cada evento é assinado (`HMAC-SHA256` sobre `<instante>.<corpo>`) e o CRM
  recusa o que estiver fora de 5 minutos: um evento capturado não vale para
  sempre.

## Pré-requisitos

- **Um número de WhatsApp dedicado** à prospecção, que você aceite perder. Nunca o
  seu pessoal, nem o de outro sistema (por exemplo, o da Cobra).
- **Node 22.13 ou mais novo** (o gateway usa o SQLite embutido, `node:sqlite`).
- O computador **ligado e sem suspender** enquanto o número precisa ficar conectado.

## Passo a passo

1. **Gere as chaves** (uma vez; nada é exibido):

   ```bash
   node scripts/set-whatsapp-gateway.mjs --crm-url http://127.0.0.1:3000
   ```

   Grava os mesmos token e segredo em `.env.local` (CRM) e `.env.gateway`
   (gateway), e deixa o modo de teste ligado. Rodar de novo mantém os valores;
   `--rotate` gera novos.

2. **Suba o CRM** (ele lê o `.env.local` ao iniciar):

   ```bash
   npm run build && npm start
   ```

3. **Suba o gateway**, em outro terminal:

   ```bash
   npm run gateway
   ```

   Deve aparecer `iniciado em MODO DE TESTE`. Confira em `http://127.0.0.1:3200/health`.

4. **Conecte**: abra `/agentes/vendedor` como owner ou admin, clique em **Gerar QR Code**
   e leia no celular do número dedicado: WhatsApp → *Aparelhos conectados* →
   *Conectar um aparelho*. A tela mostra os estados reais: Desconectado,
   Aguardando leitura, Conectando, Conectado (com o número) e Precisa reconectar.

## O que a tela faz

| Botão | Efeito |
| --- | --- |
| **Gerar QR Code** | Abre a sessão no gateway e mostra o QR (renova sozinho; expira em 5 min sem leitura). |
| **Desconectar** | Fecha o socket e **guarda a sessão**: reconectar não pede novo QR. |
| **Sair deste dispositivo** | Desloga e **apaga a sessão**: para voltar, é preciso ler o QR de novo. |

Só **owner e admin** veem o QR e usam esses botões (ler o QR vincula o WhatsApp
da empresa). Quando o WhatsApp não está conectado, um aviso aparece no topo de
todas as páginas para esses perfis.

## O que acontece quando algo cai

| Situação | Comportamento |
| --- | --- |
| **CRM fora do ar** | O gateway guarda os eventos e reenvia com espera crescente (até 5 min). Ao voltar, chegam na ordem, uma vez cada. |
| **Gateway fora do ar** | A tela mostra "Gateway offline" e o último estado que o CRM recebeu. Ao subir de novo, ele reabre sozinho as sessões já pareadas, **sem novo QR**. |
| **Queda de rede** | O gateway reconecta sozinho, com espera crescente. |
| **Celular encerra a sessão** | Estado "Precisa reconectar"; as credenciais são apagadas e só um novo QR volta. Não há reconexão automática com sessão encerrada. |
| **Segredo errado** | O CRM responde 401 e o gateway **segura a fila** (não descarta): corrigindo o segredo, tudo sai. |
| **CRM recusa um evento como inválido** | Ele fica guardado como "morto" por 7 dias e não trava os demais. A tela mostra a contagem. |

## Modo de teste

`WHATSAPP_GATEWAY_DRY_RUN=1` é o padrão. O gateway **conecta de verdade** e pode
consultar se um número tem WhatsApp, mas aceita pedidos de envio apenas
simulando (`dryrun-…`), e só se estiver conectado. Mesmo com `DRY_RUN=0`, nesta
fase o envio real continua bloqueado (HTTP 501): ele só existirá junto com a
política de envio. Isso é de propósito.

A ativação do envio real seguirá a ordem usada na Cobra: (1) modo de teste e QR
lido, número certo conectado; (2) fluxo completo contra o **seu próprio número**,
conferindo que "saiu" no histórico enquanto o log do gateway diz "não enviada";
(3) só então desligar o modo de teste, repetir com o seu número e acompanhar
entregue/lido. O passo 3 é sempre seu, nunca de um agente.

## Segurança

- O gateway escuta só em `127.0.0.1`. Nunca o exponha sem HTTPS na frente.
- `/health` é aberto (sem número nem QR); todas as outras rotas exigem
  `Authorization: Bearer <token>`, comparado em tempo constante.
- `.env.local` e `.env.gateway` não vão para o Git. O script não imprime os valores.
- O QR Code nunca passa pelo webhook nem é gravado: o CRM o busca ao vivo.
- Logs com telefone mascarado ficam para a fase em que mensagens circularem.

## Backup

`gateway/.data/gateway.db` (e os arquivos `-wal`/`-shm` ao lado, com o gateway
parado) guarda a sessão do WhatsApp. **Copiá-lo é o backup; perdê-lo exige ler o
QR de novo.** Ele contém as credenciais do número: trate como segredo.

## Variáveis do gateway (`.env.gateway`)

Ver `.env.gateway.example`. As principais: `WHATSAPP_GATEWAY_TOKEN`,
`WHATSAPP_WEBHOOK_SECRET`, `CRM_WEBHOOK_URL`, `GATEWAY_PORT`,
`WHATSAPP_GATEWAY_DRY_RUN`, `GATEWAY_FORWARD_MESSAGES` (deixe `0` até a fase do
Vendedor tratar mensagens) e `GATEWAY_DB_FILE`.

## Diferenças em relação ao gateway da Cobra

Este gateway foi portado do `agenteitalo` (Cobra) e mantém o que ele tem de mais
valioso: sessão que sobrevive a reinício, reconexão com espera, estados reais,
filtro de status/grupos/canais, modo de teste e a regra de nunca "aceitar" um
envio desconectado. O que mudou:

- **SQLite próprio** em vez de Postgres compartilhado com o app, e **sem varredura
  de lembretes nem criação de clientes** no gateway.
- Em vez de gravar mensagens direto no banco, entrega **eventos assinados** ao
  CRM a partir de uma caixa de saída durável.
- O envio real está **desligado** até existir a política de envio.
- Histórico do WhatsApp **não é importado** (o número é dedicado e novo).

## Problemas comuns

- **"Gateway offline" na tela**: o gateway não está rodando. `npm run gateway`.
- **"O gateway recusou o token"**: o token difere entre `.env.local` e
  `.env.gateway`. Rode o script de novo (ele mantém os valores já existentes).
- **A tela diz conectado, mas o aviso global não some**: o webhook não chega. Confira
  `WHATSAPP_WEBHOOK_SECRET` (igual nos dois lados) e `CRM_WEBHOOK_URL` (porta certa do
  CRM). A tela de conexão mostra "N eventos aguardam entrega ao CRM".
- **QR não aparece**: veja o terminal do gateway; sem internet o Baileys não consegue
  o QR. Gere de novo.
- **Reiniciei o CRM e o estado "voltou" antigo**: o CRM só sabe do que o gateway lhe
  contou; a tela ao vivo (direto do gateway) é a referência.
