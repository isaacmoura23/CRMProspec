import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runner e setup dos testes são CommonJS de propósito (rodam antes do tsx).
    "tests/*.cjs",
    "tests/stubs/**",
    // Mesmo motivo no servidor MCP: o hook precisa ser CommonJS para o
    // `--require` do Node interceptar os imports antes de tudo.
    "mcp/*.cjs",
    "mcp/stubs/**",
  ]),
]);

export default eslintConfig;
