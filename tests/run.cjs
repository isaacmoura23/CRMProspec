/**
 * Runner: resolve os arquivos de teste em caminhos absolutos antes de o
 * setup mover o cwd para um diretório temporário.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(dir, f));
const only = process.argv.slice(2);
const selected = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;

const tsx = path.join(dir, "..", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const result = spawnSync(
  tsx,
  ["--tsconfig", path.join(dir, "..", "tsconfig.json"), "--require", path.join(dir, "setup.cjs"), "--test", ...selected],
  { stdio: "inherit", shell: process.platform === "win32" }
);
process.exit(result.status ?? 1);
