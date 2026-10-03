import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath, safeNextPath } from "@/lib/auth-routes";

describe("rotas públicas", () => {
  it("libera login, callbacks, webhook e worker", () => {
    for (const p of ["/login", "/login?erro=x".split("?")[0]!, "/auth/callback", "/api/webhooks/resend", "/api/career/worker"]) {
      assert.equal(isPublicPath(p), true, p);
    }
  });
  it("protege o app, as actions e as rotas de currículo", () => {
    for (const p of ["/", "/dashboard", "/carreira", "/leads/abc", "/api/career/resumes/upload", "/api/career/resumes/v1/download", "/onboarding", "/conta/senha"]) {
      assert.equal(isPublicPath(p), false, p);
    }
  });
  it("não confunde prefixo parecido com rota pública", () => {
    assert.equal(isPublicPath("/loginfalso"), false);
    assert.equal(isPublicPath("/authx/callback"), false);
    assert.equal(isPublicPath("/api/career/workers-secretos"), false);
  });
});

describe("destino pós-login (redirect aberto)", () => {
  it("aceita caminho interno", () => {
    assert.equal(safeNextPath("/carreira?aba=vagas"), "/carreira?aba=vagas");
    assert.equal(safeNextPath("/leads/1"), "/leads/1");
  });
  it("recusa destino externo, protocolo-relativo e barra invertida", () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/ok\\..\\x", "javascript:alert(1)", "", null, undefined]) {
      assert.equal(safeNextPath(bad as string | null), "/dashboard", String(bad));
    }
  });
  it("recusa quebra de linha (injeção de cabeçalho no Location)", () => {
    assert.equal(safeNextPath("/ok\r\nSet-Cookie: a=b"), "/dashboard");
  });
  it("recusa os caracteres que o parser de URL descarta", () => {
    // O parser remove tab/CR/LF/controles antes de interpretar o endereço:
    // "/\t/evil.com" vira "//evil.com" — outro domínio — se o guard olhar
    // apenas o prefixo.
    for (const bad of ["/\t/evil.com", "/\u000b/evil.com", "/\u000c/evil.com", "/\u0000/evil.com", "/ /evil.com"]) {
      assert.equal(safeNextPath(bad), "/dashboard", JSON.stringify(bad));
    }
  });
  it("o destino aceito nunca troca de origem", () => {
    for (const raw of ["/\t/evil.com", "/carreira?aba=vagas", "//evil.com", "/leads/1", "/\\evil.com", "/ok#x"]) {
      const destino = new URL(safeNextPath(raw), "https://app.exemplo.com/login");
      assert.equal(destino.origin, "https://app.exemplo.com", `${JSON.stringify(raw)} -> ${destino.href}`);
    }
  });
});
