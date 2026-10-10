#!/usr/bin/env node
/**
 * Instala as skills de design do construtor Claude Code (Agente 5) em .data/skills-sites/.
 *
 * Só baixa o que está em docs/SITES_SKILLS.lock.json: arquivo de texto, no commit fixado,
 * e RECUSA gravar se o SHA-256 não bater. Nada é executado; o construtor roda sem Bash.
 *
 *   node scripts/instalar-skills-sites.mjs            instala/atualiza
 *   node scripts/instalar-skills-sites.mjs --verificar só confere o que já está instalado
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "docs", "SITES_SKILLS.lock.json"), "utf8"));
const dest = path.join(root, ".data", "skills-sites");
const verifyOnly = process.argv.includes("--verificar");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

let bad = 0;
for (const s of lock.skills) {
  const file = path.join(dest, s.nome, "SKILL.md");
  if (verifyOnly || (fs.existsSync(file) && sha(fs.readFileSync(file)) === s.sha256)) {
    const ok = fs.existsSync(file) && sha(fs.readFileSync(file)) === s.sha256;
    console.log(`${ok ? "ok      " : "AUSENTE "} ${s.nome} (${s.repo}@${s.commit.slice(0, 7)})`);
    if (!ok) bad++;
    continue;
  }
  const url = `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${s.caminho}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`FALHOU   ${s.nome}: HTTP ${res.status}`);
    bad++;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== s.sha256) {
    console.error(`RECUSADO ${s.nome}: o SHA-256 do arquivo mudou (esperado ${s.sha256.slice(0, 12)}…). Leia o diff antes de atualizar o lock.`);
    bad++;
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`instalado ${s.nome} (${buf.length} bytes, ${s.licenca})`);
}
process.exit(bad ? 1 : 0);
