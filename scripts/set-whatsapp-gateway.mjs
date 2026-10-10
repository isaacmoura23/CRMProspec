/**
 * Prepara a ligação entre o CRM e o gateway de WhatsApp, sem expor segredo.
 *
 * Uso:  node scripts/set-whatsapp-gateway.mjs [--crm-url http://127.0.0.1:3000] [--gateway-port 3200] [--rotate]
 *
 * Gera (com `crypto.randomBytes`) o token do gateway e o segredo que assina os
 * webhooks, e grava os MESMOS valores nos dois lados:
 *
 *   .env.local     (CRM)      WHATSAPP_GATEWAY_URL, WHATSAPP_GATEWAY_TOKEN, WHATSAPP_WEBHOOK_SECRET
 *   .env.gateway   (gateway)  WHATSAPP_GATEWAY_TOKEN, WHATSAPP_WEBHOOK_SECRET, CRM_WEBHOOK_URL,
 *                             GATEWAY_PORT, WHATSAPP_GATEWAY_DRY_RUN=1
 *
 * Os valores não são impressos nem registrados em log — só os nomes e o tamanho.
 * Rodar de novo mantém os valores existentes (não derruba a ligação); `--rotate`
 * gera novos. O modo de teste (DRY_RUN=1) é o padrão e este script nunca o desliga.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const crmUrl = option("--crm-url", "http://127.0.0.1:3000").replace(/\/$/, "");
const gatewayPort = option("--gateway-port", "3200");
if (!/^https?:\/\//.test(crmUrl)) {
  console.error("--crm-url precisa começar com http:// ou https://");
  process.exit(1);
}
if (!/^\d{2,5}$/.test(gatewayPort)) {
  console.error("--gateway-port inválida.");
  process.exit(1);
}

const CRM_ENV = path.join(process.cwd(), ".env.local");
const GATEWAY_ENV = path.join(process.cwd(), ".env.gateway");

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function get(content, name) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m").exec(content);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** Grava `NOME=valor`, trocando a linha existente ou acrescentando ao fim. */
function upsert(content, name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (re.test(content)) return content.replace(re, () => line);
  return `${content}${content.length && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
}

const crm = read(CRM_ENV);
const gateway = read(GATEWAY_ENV);

const rotate = flag("--rotate");
const hadKeys = Boolean(get(crm, "WHATSAPP_GATEWAY_TOKEN") || get(gateway, "WHATSAPP_GATEWAY_TOKEN"));
// Reaproveita o que já existe (CRM primeiro, depois o gateway) para não quebrar uma ligação em uso.
const token = (!rotate && (get(crm, "WHATSAPP_GATEWAY_TOKEN") || get(gateway, "WHATSAPP_GATEWAY_TOKEN"))) || crypto.randomBytes(24).toString("hex");
const secret = (!rotate && (get(crm, "WHATSAPP_WEBHOOK_SECRET") || get(gateway, "WHATSAPP_WEBHOOK_SECRET"))) || crypto.randomBytes(32).toString("hex");

let nextCrm = crm;
nextCrm = upsert(nextCrm, "WHATSAPP_GATEWAY_URL", `http://127.0.0.1:${gatewayPort}`);
nextCrm = upsert(nextCrm, "WHATSAPP_GATEWAY_TOKEN", token);
nextCrm = upsert(nextCrm, "WHATSAPP_WEBHOOK_SECRET", secret);

let nextGateway = gateway;
nextGateway = upsert(nextGateway, "WHATSAPP_GATEWAY_TOKEN", token);
nextGateway = upsert(nextGateway, "WHATSAPP_WEBHOOK_SECRET", secret);
nextGateway = upsert(nextGateway, "CRM_WEBHOOK_URL", `${crmUrl}/api/webhooks/whatsapp`);
nextGateway = upsert(nextGateway, "GATEWAY_PORT", gatewayPort);
// Seguro por padrão. Se o arquivo já tinha um valor, ele é respeitado: este script nunca liga o envio real.
if (!get(gateway, "WHATSAPP_GATEWAY_DRY_RUN")) nextGateway = upsert(nextGateway, "WHATSAPP_GATEWAY_DRY_RUN", "1");

fs.writeFileSync(CRM_ENV, nextCrm, "utf-8");
fs.writeFileSync(GATEWAY_ENV, nextGateway, "utf-8");

console.log(rotate ? "Chaves novas geradas." : hadKeys ? "Chaves prontas (as já existentes foram mantidas)." : "Chaves geradas.");
console.log(`  .env.local    → WHATSAPP_GATEWAY_URL, WHATSAPP_GATEWAY_TOKEN (${token.length} car.), WHATSAPP_WEBHOOK_SECRET (${secret.length} car.)`);
console.log(`  .env.gateway  → WHATSAPP_GATEWAY_TOKEN, WHATSAPP_WEBHOOK_SECRET, CRM_WEBHOOK_URL=${crmUrl}/api/webhooks/whatsapp, GATEWAY_PORT=${gatewayPort}`);
console.log(`  Modo de teste: ${get(nextGateway, "WHATSAPP_GATEWAY_DRY_RUN") === "1" ? "LIGADO (nada é enviado)" : "conforme o seu .env.gateway"}`);
console.log("\nPróximos passos:");
console.log("  1. Reinicie o servidor do CRM (ele lê o .env.local ao subir).");
console.log("  2. Em outro terminal: npm run gateway");
console.log("  3. Abra /agentes/vendedor e gere o QR Code.");
