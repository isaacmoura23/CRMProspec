/**
 * Permite importar os módulos do app fora do runtime do Next.
 *
 * Boa parte do domínio começa com `import "server-only"` e algumas partes
 * usam `after()` de `next/server` ou `revalidatePath` de `next/cache` —
 * todos lançam erro fora de uma requisição do Next. Aqui eles viram no-ops,
 * do mesmo jeito que em tests/setup.cjs, para o servidor MCP poder chamar o
 * código de verdade em vez de reimplementá-lo.
 *
 * Diferente dos testes, o diretório de trabalho continua sendo o do projeto:
 * o MCP opera sobre o banco local real (.data/db.json), que é o ponto.
 */
const Module = require("module");
const path = require("path");

const STUBS = {
  "server-only": path.join(__dirname, "stubs", "noop.js"),
  "next/server": path.join(__dirname, "stubs", "next-server.js"),
  "next/cache": path.join(__dirname, "stubs", "next-cache.js"),
};

const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return STUBS[request];
  return resolveOriginal.call(this, request, ...rest);
};

// O .env.local não é carregado automaticamente fora do Next.
const fs = require("fs");
const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  for (const linha of fs.readFileSync(envFile, "utf-8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(linha.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
