/**
 * Teste de fumaça do servidor MCP.
 *
 * Sobe o servidor como um cliente MCP real faria (processo próprio, stdio),
 * lista as ferramentas e chama as de leitura. Serve para pegar os erros que
 * só aparecem no transporte: import que falha fora do Next, schema inválido,
 * log escrito em stdout corrompendo o protocolo.
 *
 * Uso:  npm run mcp:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Só ferramentas que não escrevem nem gastam cota de API. */
const CHAMADAS: Array<{ nome: string; args: Record<string, unknown> }> = [
  { nome: "crm_panorama", args: {} },
  { nome: "leads_buscar", args: { limite: 3 } },
  { nome: "leads_auditar", args: { fonte: "google_places" } },
  { nome: "filtros_explicar", args: { noWebsite: true, hasInstagram: true } },
  { nome: "analise_amostrar", args: { quantidade: 2 } },
  { nome: "email_testar_extracao", args: { html: '<a href="mailto:contato@imob.com.br">x</a> por agencia@outra.com.br', site: "https://imob.com.br" } },
  { nome: "carreira_estado", args: {} },
  { nome: "agentes_estado", args: {} },
];

async function main() {
  const transporte = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["tsx", "--require", "./mcp/runtime.cjs", "./mcp/server.ts"],
    cwd: process.cwd(),
  });
  const cliente = new Client({ name: "smoke", version: "1.0.0" });
  await cliente.connect(transporte);

  const { tools } = await cliente.listTools();
  console.log(`\nFerramentas publicadas: ${tools.length}`);
  for (const t of tools) console.log(`  ${t.name} — ${t.title ?? ""}`);

  let falhas = 0;
  for (const { nome, args } of CHAMADAS) {
    process.stdout.write(`\n── ${nome} `);
    try {
      const r = await cliente.callTool({ name: nome, arguments: args });
      const texto = (r.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      if (r.isError) {
        console.log("ERRO");
        console.log(texto.slice(0, 400));
        falhas += 1;
      } else {
        console.log(`ok (${texto.length} caracteres)`);
        console.log(texto.split("\n").slice(0, 6).map((l) => `   ${l}`).join("\n"));
      }
    } catch (err) {
      console.log("EXCEÇÃO");
      console.log("  ", err instanceof Error ? err.message : String(err));
      falhas += 1;
    }
  }

  // Não chamamos `prospectar` nem `fonte_sondar`: gravam leads e gastam cota.
  const semTeste = tools.map((t) => t.name).filter((n) => !CHAMADAS.some((c) => c.nome === n));
  if (semTeste.length) console.log(`\nNão exercitadas (escrevem ou consomem cota): ${semTeste.join(", ")}`);

  await cliente.close();
  console.log(falhas === 0 ? "\nTudo respondeu.\n" : `\n${falhas} ferramenta(s) com falha.\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("falha no teste:", err);
  process.exit(1);
});
