/**
 * Diz o que falta para a produção funcionar, sem imprimir nenhuma chave.
 *
 * Uso:  node scripts/verificar-supabase.mjs
 *
 * Confere, nesta ordem: variáveis presentes, conexão, tabelas de cada
 * migração, bucket privado dos currículos e o gatilho de cadastro. Cada
 * item diz o que fazer quando falha.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_FILE = path.join(process.cwd(), ".env.local");
if (fs.existsSync(ENV_FILE)) {
  for (const linha of fs.readFileSync(ENV_FILE, "utf-8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(linha.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ok = (t) => console.log(`  ok    ${t}`);
const falta = (t, comoResolver) => {
  console.log(`  FALTA ${t}`);
  if (comoResolver) console.log(`        → ${comoResolver}`);
  problemas += 1;
};
let problemas = 0;

console.log("\nVariáveis de ambiente");
if (url) ok("NEXT_PUBLIC_SUPABASE_URL"); else falta("NEXT_PUBLIC_SUPABASE_URL", "node scripts/set-supabase.mjs");
if (anon) ok("NEXT_PUBLIC_SUPABASE_ANON_KEY (ativa o login real)"); else falta("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sem ela o app fica em modo demo, com login sem senha");
if (service) ok("SUPABASE_SERVICE_ROLE_KEY"); else falta("SUPABASE_SERVICE_ROLE_KEY", "o servidor precisa dela para ler app_users e a fila");
for (const nome of ["CRON_SECRET", "CAREER_TOKEN_SECRET"]) {
  if (process.env[nome]) ok(nome); else falta(nome, "node scripts/set-supabase.mjs gera os dois");
}

if (!url || !service) {
  console.log("\nSem URL e service role não dá para conferir o banco. Rode o set-supabase primeiro.\n");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(url, service, { auth: { persistSession: false } });

console.log("\nTabelas");
const TABELAS = [
  ["app_leads", "0002_leads_hibrido.sql"],
  ["app_lead_analysis", "0002_leads_hibrido.sql"],
  ["app_lead_score_history", "0002_leads_hibrido.sql"],
  ["career_profiles", "0003_carreira.sql"],
  ["career_resumes", "0003_carreira.sql"],
  ["career_applications", "0003_carreira.sql"],
  ["career_queue", "0003_carreira.sql"],
  ["app_users", "0004_auth.sql"],
  ["app_invites", "0004_auth.sql"],
  ["agent_settings", "0005_agentes.sql"],
  ["agent_tasks", "0005_agentes.sql"],
  ["agent_events", "0005_agentes.sql"],
  ["agent_heartbeats", "0005_agentes.sql"],
  ["niche_targets", "0005_agentes.sql"],
  ["approvals", "0005_agentes.sql"],
  ["spend_ledger", "0005_agentes.sql"],
  ["whatsapp_link", "0006_whatsapp.sql"],
  ["whatsapp_receipts", "0006_whatsapp.sql"],
  ["outreach_cycles", "0007_vendedor.sql"],
  ["outreach_messages", "0007_vendedor.sql"],
  ["channel_blocklist", "0007_vendedor.sql"],
  ["conversation_state", "0008_conversa.sql"],
  ["meetings", "0008_conversa.sql"],
  ["owner_notices", "0008_conversa.sql"],
  ["lead_dossiers", "0009_dossie.sql"],
  ["site_builds", "0010_sites.sql"],
  ["social_posts", "0011_social_trafego.sql"],
  ["ad_campaigns", "0011_social_trafego.sql"],
  ["ad_reports", "0011_social_trafego.sql"],
  ["prospect_coverage", "0012_prospeccao.sql"],
];
const pendentes = new Set();
for (const [tabela, migracao] of TABELAS) {
  const { error } = await sb.from(tabela).select("*", { count: "exact", head: true });
  if (!error) ok(tabela);
  else {
    falta(`${tabela} (${error.message})`);
    pendentes.add(migracao);
  }
}
if (pendentes.size) {
  console.log(`\n  Rode no SQL Editor do Supabase, nesta ordem: ${[...pendentes].join(", ")}`);
  console.log("  (ou cole database/setup-producao.sql, que já traz todas na ordem)");
}

console.log("\nArmazenamento");
const { data: buckets, error: erroBuckets } = await sb.storage.listBuckets();
if (erroBuckets) falta(`não foi possível listar buckets (${erroBuckets.message})`);
else {
  const bucket = buckets.find((b) => b.id === "career-resumes");
  if (!bucket) falta("bucket career-resumes", "a 0003 cria o bucket; rode-a no SQL Editor");
  else if (bucket.public) falta("bucket career-resumes está PÚBLICO", "deixe-o privado: currículos são dados pessoais");
  else ok("bucket career-resumes (privado)");
}

console.log("\nCadastro");
const { count, error: erroUsuarios } = await sb.from("app_users").select("id", { count: "exact", head: true });
if (erroUsuarios) falta(`app_users ilegível (${erroUsuarios.message})`);
else if ((count ?? 0) === 0) console.log("  aviso  nenhuma conta ainda — a primeira que se cadastrar vira owner");
else ok(`${count} conta(s) em app_users`);

console.log(
  problemas === 0
    ? "\nTudo pronto. Falta só repetir as variáveis na Vercel (vercel env add) e publicar.\n"
    : `\n${problemas} item(ns) pendente(s).\n`
);
process.exit(problemas === 0 ? 0 : 1);
