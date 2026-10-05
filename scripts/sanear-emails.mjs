/**
 * Remove dos leads já gravados os e-mails que não são da empresa.
 *
 * Uso:  node scripts/sanear-emails.mjs           (mostra o que mudaria)
 *       node scripts/sanear-emails.mjs --aplicar (grava)
 *
 * Até setembro de 2026 o enriquecimento guardava o primeiro e-mail que
 * aparecia no HTML do site — e o primeiro costuma ser o do rodapé
 * "desenvolvido por…". O mesmo endereço de uma agência chegou a constar
 * como contato de cinco imobiliárias diferentes. A regra nova (pickEmail,
 * em services/enrichment.ts) só aceita e-mail do domínio do site ou de
 * provedor público; este script aplica a mesma regra ao que já está salvo.
 */
import fs from "node:fs";
import path from "node:path";

const DB = path.join(process.cwd(), ".data", "db.json");
const aplicar = process.argv.includes("--aplicar");

const PROVEDORES_PUBLICOS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br",
  "live.com", "msn.com", "yahoo.com", "yahoo.com.br", "icloud.com", "me.com", "uol.com.br",
  "bol.com.br", "terra.com.br", "ig.com.br", "globo.com", "sapo.pt", "clix.pt",
]);

function dominioDe(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

if (!fs.existsSync(DB)) {
  console.log("Nenhum banco local em .data/db.json — nada a sanear.");
  process.exit(0);
}
const db = JSON.parse(fs.readFileSync(DB, "utf-8"));

const suspeitos = [];
for (const lead of db.leads) {
  if (!lead.email) continue;
  const dominioEmail = lead.email.split("@")[1] ?? "";
  if (PROVEDORES_PUBLICOS.has(dominioEmail)) continue;
  const site = dominioDe(lead.website);
  // Sem site não há como confirmar o dono do domínio: mantém, para não
  // apagar um contato legítimo que veio de outra fonte (CSV, manual).
  if (!site) continue;
  if (dominioEmail === site || dominioEmail.endsWith(`.${site}`) || site.endsWith(`.${dominioEmail}`)) continue;
  suspeitos.push(lead);
}

// Um endereço que se repete entre empresas é quase sempre do fornecedor.
const repetidos = new Map();
for (const lead of suspeitos) repetidos.set(lead.email, (repetidos.get(lead.email) ?? 0) + 1);

console.log(`\n${suspeitos.length} lead(s) com e-mail de domínio diferente do site:\n`);
for (const lead of suspeitos) {
  const vezes = repetidos.get(lead.email);
  console.log(`  ${lead.company_name}`);
  console.log(`      e-mail: ${lead.email}${vezes > 1 ? `  (aparece em ${vezes} empresas)` : ""}`);
  console.log(`      site:   ${lead.website}`);
}

if (!aplicar) {
  console.log(`\nNada foi alterado. Para remover esses e-mails: node scripts/sanear-emails.mjs --aplicar\n`);
  process.exit(0);
}

const backup = `${DB}.antes-saneamento-${Date.now()}`;
fs.copyFileSync(DB, backup);
for (const lead of suspeitos) {
  lead.email = null;
  lead.updated_at = new Date().toISOString();
}
fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log(`\n${suspeitos.length} e-mail(s) removido(s). Backup em ${path.basename(backup)}.\n`);
