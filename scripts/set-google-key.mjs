/**
 * Grava GOOGLE_PLACES_API_KEY no .env.local sem a chave passar por terceiros.
 *
 * Uso:  node scripts/set-google-key.mjs
 *
 * A chave é lida do teclado com o eco desligado, gravada no arquivo e nunca
 * impressa na tela nem registrada em log.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_FILE = path.join(process.cwd(), ".env.local");
const VAR = "GOOGLE_PLACES_API_KEY";

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      // Redesenha a linha sem revelar o que foi digitado.
      if (![`\n`, `\r`, ``].includes(char.toString())) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(question);
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// Sem terminal interativo (por exemplo, rodado de dentro de outra ferramenta)
// não há como ler a digitação: o processo morreria esperando para sempre.
if (!process.stdin.isTTY) {
  console.error(
    "Este script precisa de um terminal interativo para receber a chave.\n" +
      "Abra um terminal comum na pasta do projeto e rode novamente,\n" +
      "ou edite o .env.local e cole a chave na linha GOOGLE_PLACES_API_KEY=."
  );
  process.exit(1);
}

const key = await askHidden("Cole a chave do Google Places e pressione Enter: ");

if (!key) {
  console.error("Nenhuma chave informada. Nada foi alterado.");
  process.exit(1);
}
if (/\s/.test(key)) {
  console.error("A chave contém espaços. Copie novamente, sem quebras de linha.");
  process.exit(1);
}
if (!key.startsWith("AIza")) {
  console.error('Aviso: chaves do Google costumam começar com "AIza". Verifique se copiou a certa.');
}

let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
const line = `${VAR}=${key}`;

if (new RegExp(`^\\s*${VAR}\\s*=.*$`, "m").test(content)) {
  content = content.replace(new RegExp(`^\\s*${VAR}\\s*=.*$`, "m"), line);
} else {
  if (content.length && !content.endsWith("\n")) content += "\n";
  content += `${line}\n`;
}

fs.writeFileSync(ENV_FILE, content, "utf-8");
console.log(`\n${VAR} gravada em .env.local (${key.length} caracteres).`);
console.log("Reinicie o servidor para a mudança valer: npm run dev");
