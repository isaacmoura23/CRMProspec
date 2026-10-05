import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickEmail } from "@/services/enrichment";

/**
 * Casos tirados da base real de 84 imobiliárias prospectadas: o mesmo
 * endereço de uma agência de sites tinha sido gravado como contato de cinco
 * empresas diferentes, porque a extração pegava o primeiro e-mail do HTML.
 */
describe("escolha do e-mail de contato", () => {
  it("prefere o e-mail do próprio domínio ao do fornecedor do site", () => {
    const html = `
      <footer>
        <a href="mailto:contato@akgimoveis.com.br">Fale conosco</a>
        <p>Desenvolvido por IC Informática — robison@icinformatica.com.br</p>
      </footer>`;
    assert.equal(pickEmail(html, "https://www.akgimoveis.com.br/"), "contato@akgimoveis.com.br");
  });

  it("descarta o e-mail do fornecedor quando a empresa não publica o próprio", () => {
    const html = `<footer>Site por IC Informática — robison@icinformatica.com.br</footer>`;
    assert.equal(pickEmail(html, "https://www.lucimaraimoveis.com.br/"), null);
    assert.equal(pickEmail(`<p>website@properfy.com.br</p>`, "https://galvao.com.br"), null);
  });

  it("aceita provedor público: é a conta da própria empresa", () => {
    assert.equal(
      pickEmail(`<a href="mailto:juliane.corretoradeimoveis@gmail.com">e-mail</a>`, "https://julianecorretoradeimoveis.com.br"),
      "juliane.corretoradeimoveis@gmail.com"
    );
    assert.equal(pickEmail(`contato: casamaciel@hotmail.com`, "https://macielcorretordeimoveis.com"), "casamaciel@hotmail.com");
  });

  it("aceita subdomínio e e-mail do domínio quando não há site conhecido", () => {
    assert.equal(pickEmail(`vendas@loja.imob.com.br`, "https://imob.com.br"), "vendas@loja.imob.com.br");
    assert.equal(pickEmail(`contato@qualquer.com.br`, undefined), null, "sem site, domínio corporativo não é confiável");
    assert.equal(pickEmail(`contato@gmail.com`, undefined), "contato@gmail.com", "sem site, provedor público ainda serve");
  });

  it("ignora caixas que não atendem prospecção e lixo de template", () => {
    const html = `noreply@imob.com.br dpo@imob.com.br sentry@sentry.wixpress.com contato@imob.com.br`;
    assert.equal(pickEmail(html, "https://imob.com.br"), "contato@imob.com.br");
    assert.equal(pickEmail(`<img src="logo@2x.png">`, "https://imob.com.br"), null);
  });

  it("não devolve e-mail quando o site não publica nenhum", () => {
    assert.equal(pickEmail(`<html><body>sem contato aqui</body></html>`, "https://imob.com.br"), null);
  });
});
