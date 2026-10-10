/**
 * Preparação dos testes:
 *  - mapeia módulos do runtime do Next para stubs;
 *  - move o cwd para um diretório temporário, para o snapshot demo
 *    (.data/db.json) não tocar o banco real do projeto.
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const stubs = {
  "server-only": path.join(__dirname, "stubs", "server-only.js"),
  "next/server": path.join(__dirname, "stubs", "next-server.js"),
  "next/cache": path.join(__dirname, "stubs", "next-cache.js"),
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  return orig.call(this, request, ...rest);
};

// A raiz real do projeto, para os testes que leem o código-fonte: o cwd
// passa a ser um diretório temporário logo abaixo.
process.env.CRM_ROOT = path.join(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crm-career-tests-"));
process.chdir(tmp);
process.env.NODE_ENV = "test";
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;
