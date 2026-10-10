# Servidor MCP do ProspecAtlas

Ferramentas de desenvolvimento sobre o CRM, expostas pelo Model Context
Protocol. Cada uma nasceu de um script descartável escrito durante o
trabalho — medir quantas empresas da fonte têm site, descobrir que o mesmo
e-mail de uma agência constava como contato de sete imobiliárias, conferir
se as análises saíam idênticas. Em vez de reescrevê-los a cada sessão, são
ferramentas.

O servidor roda sobre o código real do app: lê `.data/db.json` e chama os
mesmos provedores e serviços que a aplicação usa. É local, por stdio, para
desenvolvimento — **não** é uma API de produção.

## Como usar

No Claude Code, o [`.mcp.json`](../.mcp.json) da raiz já registra o servidor:
abra o projeto e as ferramentas aparecem. Para conferir se tudo responde:

```bash
npm run mcp:smoke
```

O teste sobe o servidor como um cliente real faria, lista as ferramentas e
chama as de leitura. Ele não exercita `prospectar` nem `fonte_sondar`, que
escrevem no banco ou consomem cota do Google.

Para rodar o servidor à mão (ele fala o protocolo pelo stdin/stdout, então
não é legível no terminal):

```bash
npm run mcp
```

## Ferramentas

| Ferramenta | O que faz | Escreve? |
|---|---|---|
| `crm_panorama` | Leads por fonte/nicho/cidade, usuários, últimas prospecções, o que está configurado no ambiente | não |
| `leads_buscar` | Filtra os leads gravados por texto, fonte, nicho, cidade, score e canais | não |
| `leads_auditar` | Procura e-mail de fornecedor, e-mail repetido entre empresas, Instagram que não bate, leads sem contato e duplicatas | não |
| `fonte_sondar` | Consulta o Google Places e mostra o que a fonte tem a oferecer (quantas sem site, com telefone…) sem gravar | não, mas gasta cota |
| `filtros_explicar` | Diz se a combinação de filtros é viável e quantos leads passariam | não |
| `prospectar` | Roda o job de prospecção completo e devolve o descarte por critério | **sim**, e gasta cota |
| `analise_amostrar` | Mostra a análise gerada para alguns leads, lado a lado | não |
| `email_testar_extracao` | Aplica `pickEmail` num HTML e diz qual endereço seria gravado | não |
| `carreira_estado` | Currículos, vagas, candidaturas e a fila de jobs do módulo Carreira | não |
| `agentes_estado` | Fila de tarefas dos agentes, nichos ranqueados, pedidos de aprovação e últimos eventos (retrato do último salvamento do `.data/db.json`) | não |

## Como funciona por dentro

Boa parte do domínio começa com `import "server-only"`, e algumas partes
usam `after()` ou `revalidatePath` — todos lançam erro fora de uma requisição
do Next. O [`runtime.cjs`](runtime.cjs) intercepta esses três módulos e os
substitui por no-ops antes de qualquer import, pelo `--require` do Node. É a
mesma técnica de `tests/setup.cjs`, com uma diferença: aqui o diretório de
trabalho continua sendo o do projeto, porque o ponto é operar sobre o banco
local de verdade.

Dois detalhes que custam tempo quando esquecidos:

- **Log vai para stderr.** stdout é o canal do protocolo; qualquer linha
  solta ali corrompe a conversa com o cliente.
- **Sem `await` de topo.** O `tsx` compila como CommonJS neste projeto (o
  `package.json` não declara `"type": "module"`), e top-level await falha
  nesse formato — daí a função `iniciar()` no fim do servidor.

## Acrescentar uma ferramenta

Em [`server.ts`](server.ts), use `servidor.registerTool(nome, config, cb)`.
O `inputSchema` é um objeto de campos Zod (não um `z.object`). Marque
`annotations.readOnlyHint` nas de leitura — é o que diz ao cliente que a
chamada é segura. Depois acrescente a ferramenta à lista do
[`smoke.ts`](smoke.ts) se ela não escrever nem gastar cota.
