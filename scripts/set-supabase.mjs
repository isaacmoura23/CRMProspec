/**
 * Grava as variáveis do Supabase no .env.local sem as chaves passarem por
 * terceiros.
 *
 * Uso:  node scripts/set-supabase.mjs
 *
 * Cada valor é lido do teclado com o eco desligado, gravado no arquivo e
 * nunca impresso na tela nem registrado em log. Os dois segredos próprios
 * da aplicação (CRON_SECRET e CAREER_TOKEN_SECRET) são sorteados aqui
 * mesmo — não vêm de serviço nenhum.
 *
 * Onde achar cada valor, no painel do Supabase:
 *   Settings → API
 *     Project URL        -> NEXT_PUBLIC_SUPABASE_URL
 *     anon / public      -> NEXT_PUBLIC_SUPABASE_ANON_KEY
 *     service_role       -> SUPABASE_SERVICE_ROLE_KEY   (secreta: só servidor)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_FILE = path.join(process.cwd(), ".env.local");

const CAMPOS = [
  {
    nome: "NEXT_PUBLIC_SUPABASE_URL",
    rotulo: "Project URL (ex.: https://abcdefgh.supabase.co)",
    oculto: false,
    valida: (v) => (/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(v.trim()) ? null : "Deve ser a URL do projeto, como https://abcdefgh.supabase.co"),
  },
  {
    nome: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    rotulo: "anon / public key",
    oculto: true,
    valida: (v) => (v.trim().length > 20 ? null : "Chave curta demais — confira se copiou inteira."),
  },
  {
    nome: "SUPABASE_SERVICE_ROLE_KEY",
    rotulo: "service_role key (secreta)",
    oculto: true,
    valida: (v) => (v.trim().length > 20 ? null : "Chave curta demais — confira se copiou inteira."),
  },
];

function pergunta(texto, oculto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!oculto) {
      rl.question(`${texto}: `, (resposta) => {
        rl.close();
        resolve(resposta.trim());
      });
      return;
    }
    const onData = () => {
      // Redesenha a linha sem revelar o que foi digitado.
      const linha = rl.line ?? "";
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`${texto}: ${"*".repeat(linha.length)}`);
    };
    process.stdin.on("data", onData);
    rl.question(`${texto}: `, (resposta) => {
      process.stdin.off("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(resposta.trim());
    });
  });
}

/** Substitui a linha da variável, ou acrescenta no fim. Preserva o resto. */
function gravar(conteudo, nome, valor) {
  const linha = `${nome}=${valor}`;
  const re = new RegExp(`^${nome}=.*$`, "m");
  if (re.test(conteudo)) return conteudo.replace(re, linha);
  return `${conteudo.trimEnd()}\n${linha}\n`;
}

const existente = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
let conteudo = existente;

console.log("\nConfiguração do Supabase — os valores não aparecem na tela nem em log.\n");

for (const campo of CAMPOS) {
  let valor = "";
  for (;;) {
    valor = await pergunta(`  ${campo.rotulo}`, campo.oculto);
    if (!valor) {
      console.log("    (vazio — pulando este campo)");
      break;
    }
    const erro = campo.valida(valor);
    if (!erro) break;
    console.log(`    ${erro}`);
  }
  if (valor) conteudo = gravar(conteudo, campo.nome, valor);
}

// Segredos próprios: sorteados, nunca digitados.
for (const nome of ["CRON_SECRET", "CAREER_TOKEN_SECRET"]) {
  const jaTem = new RegExp(`^${nome}=.+$`, "m").test(conteudo);
  if (jaTem) {
    console.log(`  ${nome}: já definido, mantido.`);
    continue;
  }
  conteudo = gravar(conteudo, nome, crypto.randomBytes(32).toString("base64url"));
  console.log(`  ${nome}: gerado.`);
}

fs.writeFileSync(ENV_FILE, conteudo, { mode: 0o600 });
console.log(`\nGravado em ${ENV_FILE}.`);
console.log("Agora rode:  node scripts/verificar-supabase.mjs\n");
