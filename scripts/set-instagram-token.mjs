/**
 * Grava INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ID no .env.local sem o token passar por terceiros.
 *
 * Uso:  node scripts/set-instagram-token.mjs
 *
 * O ID da conta é lido normalmente (não é segredo); o token é lido do teclado com o eco
 * desligado, gravado no arquivo e nunca impresso na tela nem registrado em log. Mesmo molde do
 * set-anthropic-key.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_FILE = path.join(process.cwd(), ".env.local");

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (hidden && ![`\n`, `\r`, ``].includes(char.toString())) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(question);
      }
    };
    if (hidden) process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      if (hidden) process.stdin.removeListener("data", onData);
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

if (!process.stdin.isTTY) {
  console.error(
    "Este script precisa de um terminal interativo para receber o token.\n" +
      "Abra um terminal comum na pasta do projeto e rode novamente,\n" +
      "ou edite o .env.local e preencha INSTAGRAM_ACCESS_TOKEN= e INSTAGRAM_BUSINESS_ID=."
  );
  process.exit(1);
}

console.log("Precisa de uma conta Instagram Business ligada a uma página do Facebook e de um token de longa duração da API Graph.");
const id = await ask("ID da conta Instagram Business (só números): ", false);
if (!/^\d{5,30}$/.test(id)) {
  console.error("O ID da conta deve ter só números. Nada foi alterado.");
  process.exit(1);
}
const token = await ask("Cole o token de acesso e pressione Enter: ", true);
if (!token) {
  console.error("Nenhum token informado. Nada foi alterado.");
  process.exit(1);
}
if (/\s/.test(token)) {
  console.error("O token contém espaços. Copie novamente, sem quebras de linha.");
  process.exit(1);
}

let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : "";
function setVar(name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (re.test(content)) content = content.replace(re, line);
  else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += `${line}\n`;
  }
}
setVar("INSTAGRAM_BUSINESS_ID", id);
setVar("INSTAGRAM_ACCESS_TOKEN", token);
fs.writeFileSync(ENV_FILE, content, "utf-8");
console.log(`\nINSTAGRAM_BUSINESS_ID e INSTAGRAM_ACCESS_TOKEN gravados em .env.local (token com ${token.length} caracteres).`);
console.log("Reinicie o servidor para a mudança valer.");
