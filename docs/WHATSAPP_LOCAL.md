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

Há três degraus de envio, e a tela do Vendedor mostra em qual você está:

1. **Simulado** (`WHATSAPP_GATEWAY_DRY_RUN=1`, o padrão). O gateway **conecta de
   verdade** e consulta se um número tem WhatsApp, mas aceita pedidos de envio só
   simulando (`dryrun-…`), e só se estiver conectado. Nada sai.
2. **Teste restrito** (`DRY_RUN=0` **e** `WHATSAPP_ALLOWED_RECIPIENTS=+55…` com o
   seu número). Só os números da lista recebem de verdade; qualquer outro destino
   continua simulado. É aqui que você confere o fluxo inteiro: o Vendedor
   escolhe um lead de teste, a mensagem aparece em **/agentes/aprovacao**, você
   aprova e ela chega no seu celular, com status enviada → entregue → lida.
3. **Real** (`DRY_RUN=0` e lista vazia). O passo 3 é sempre seu: nenhum agente liga isso.

Mesmo fora do modo simulado, **o gateway só envia com uma autorização assinada
pelo CRM** em cada mensagem (HMAC com o segredo compartilhado, presa à sessão,
ao número, ao texto e à referência, válida por 2 minutos). Quem alcançar a porta
do gateway sem o segredo não consegue mandar nada. A mesma referência nunca
envia duas vezes (tabela `sends` do gateway); se o WhatsApp não confirmar a tempo, o ciclo
fica **incerto** e **nunca é reenviado**: um evento de entrega posterior o resolve.

Para ver o fluxo sem número nenhum, `GATEWAY_SIMULATE=1` troca o WhatsApp por um
socket falso (aprovar → enviar → entregue), só para desenvolvimento.

## Conversa: o que o Vendedor faz quando o lead responde

O gateway entrega ao CRM as mensagens dos leads (`GATEWAY_FORWARD_MESSAGES`, ligado por
padrão) e as que **você** escreve pelo celular. O CRM só guarda mensagens de números
que são de algum lead (com ou sem o nono dígito); o resto é ignorado, sem guardar o texto.

1. **Pediu para parar** ("pare", "não quero", "me tira da lista", "número errado",
   "spam"…): regra fixa, **antes de qualquer modelo**. O número vai para a lista de
   bloqueio, o lead vira "perdido" e tudo o que estava a caminho (follow-ups, pedidos
   de aprovação) é cancelado. O Vendedor não responde nada, nem com o agente pausado.
2. **Você escreveu pelo celular**: a conversa passa para você. O agente cancela o que
   tinha a caminho e não escreve mais naquele lead (o painel mostra "Com você", com o
   botão "Devolver ao agente"). O eco das mensagens que o próprio gateway enviou é
   reconhecido e **não** conta como você.
3. **Qualquer outra resposta**: é gravada na conversa do CRM (/conversas), o lead vira
   "respondeu", o sino avisa, e o Vendedor classifica (modelo, se houver chave, ou regras)
   dentro de uma lista fechada de categorias:
   - interesse, "quer saber mais", reunião, proposta ou preço → registra o interesse
     (a prova que o Agente 5 vai exigir), propõe **dois horários** dentro da
     disponibilidade configurada e, quando o lead escolhe um, marca a reunião;
   - "agora não" ou retorno futuro → reconhece e agenda o retorno para daqui a 30 dias;
   - "já tenho fornecedor" → deixa a porta aberta;
   - sem interesse → encerra, sem responder nem insistir;
   - mídia, mensagem vaga, dúvida fora do roteiro, horário que não ficou claro, lead que o
     Vendedor nunca abordou ou frase proibida pelo perfil da empresa → **passa para você**
     (aparece em "Precisam de você" e no sino).

O texto do lead é **dado, nunca instrução**: o modelo só escolhe uma categoria; a resposta
sai de modelos fixos, nunca leva link, preço nem promessa, e **só vai ao telefone que o
Vendedor já confirmou**, nunca a um número que apareça na mensagem. Respostas seguem o
modo do agente: em "Em aprovação" você lê e aprova cada uma (com edição); em
"Automático" saem sozinhas, dentro da janela e do intervalo (mas sem pesar no teto diário
de abordagens frias). Uma resposta parada por mais de dois dias, ou com horários que já
passaram, **não sai**: passa para você.

### Aviso de reunião no seu WhatsApp

Em **/agentes/vendedor › Reuniões e aviso ao seu WhatsApp**, configure os dias e horários das
reuniões e o **seu número pessoal**. Quando uma reunião é marcada, o CRM cria a tarefa e o
aviso no sino e envia, pelo número de prospecção, uma mensagem com lead, dia e hora e o que
o lead disse. Esse aviso passa pela autorização do gateway e pela idempotência (nunca sai
duas vezes; sem confirmação, não é repetido). **No teste restrito, o seu número pessoal
também precisa estar em `WHATSAPP_ALLOWED_RECIPIENTS`.** Se o número de prospecção cair ou for
banido, o aviso não sai — por isso o sino e o painel sempre avisam.

### Para testar sem número de verdade

Com `GATEWAY_SIMULATE=1`, o gateway aceita `POST /sessions/<org>/simulate-inbound` (com o
token) `{"peer":"5541999990001","text":"Quanto custa?","fromMe":false}` e injeta a mensagem
pelo mesmo caminho do WhatsApp real. A rota não existe fora do modo simulado.

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
`WHATSAPP_GATEWAY_DRY_RUN`, `WHATSAPP_ALLOWED_RECIPIENTS` (teste restrito),
`GATEWAY_FORWARD_DELIVERY` (status de entrega ao CRM; padrão ligado),
`GATEWAY_FORWARD_MESSAGES` (respostas dos leads e mensagens suas pelo celular; padrão ligado),
`GATEWAY_SIMULATE` e `GATEWAY_DB_FILE`.

## Política de envio do Vendedor

Tudo isso é decidido no CRM, não no gateway, e editável em **/agentes/vendedor**:
janela (padrão seg–sex, 9h–18h, horário de São Paulo), teto diário com
aquecimento (10, 20, 30… até o máximo configurado), intervalo aleatório entre
mensagens (60–180 s), no máximo 3 toques por lead com 3–4 dias entre eles, aviso
de saída em toda mensagem e lista de bloqueio. Só entram celulares brasileiros
confirmados no WhatsApp; o resto vira "sem WhatsApp" no registro. Esperar (fora
da janela, teto atingido, WhatsApp desconectado, modo pausado) **não conta como
tentativa** e nunca descarta a mensagem; já uma mensagem aprovada que ficou parada
até o dia seguinte da etapa original é tratada como obsoleta e não sai.

## Diferenças em relação ao gateway da Cobra

Este gateway foi portado do `agenteitalo` (Cobra) e mantém o que ele tem de mais
valioso: sessão que sobrevive a reinício, reconexão com espera, estados reais,
filtro de status/grupos/canais, modo de teste e a regra de nunca "aceitar" um
envio desconectado. O que mudou:

- **SQLite próprio** em vez de Postgres compartilhado com o app, e **sem varredura
  de lembretes nem criação de clientes** no gateway.
- Em vez de gravar mensagens direto no banco, entrega **eventos assinados** ao
  CRM a partir de uma caixa de saída durável.
- O envio só ocorre com **autorização assinada pelo CRM** por mensagem, e a política de envio mora no CRM.
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
