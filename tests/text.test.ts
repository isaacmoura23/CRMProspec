import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEmails, extractPhones, extractUrlsFromText, parseDateRange, detectSection } from "@/lib/resume-text";
import { csvCell, extractRequirements, findApplicationEmail, isValidEmail, jobCanonicalKey, sanitizeHeader, textToHtml, htmlToText } from "@/lib/job-text";

describe("resume-text", () => {
  it("extrai URLs com e sem esquema, inclusive linkedin/github sem www", () => {
    const urls = extractUrlsFromText("Perfil: linkedin.com/in/maria-silva. Código em https://github.com/maria/app, site www.maria.dev.");
    assert.deepEqual(urls, ["https://linkedin.com/in/maria-silva", "https://github.com/maria/app", "https://www.maria.dev/"]);
  });
  it("extrai e-mails e telefones", () => {
    assert.deepEqual(extractEmails("Contato: Maria@Exemplo.com / outro@x.org"), ["maria@exemplo.com", "outro@x.org"]);
    assert.ok(extractPhones("Tel: +55 (11) 91234-5678").length === 1);
  });
  it("reconhece intervalos de datas em pt/en", () => {
    assert.deepEqual(parseDateRange("Analista — mar/2021 – atual"), { start: "2021-03", end: null, raw: "mar/2021 – atual" });
    assert.deepEqual(parseDateRange("Jan 2019 - Dec 2020")?.start, "2019-01");
    assert.deepEqual(parseDateRange("01/2020 a 06/2021"), { start: "2020-01", end: "2021-06", raw: "01/2020 a 06/2021" });
    assert.equal(parseDateRange("sem datas aqui"), null);
  });
  it("detecta cabeçalhos de seção", () => {
    assert.equal(detectSection("Experiência Profissional"), "experience");
    assert.equal(detectSection("EDUCATION"), "education");
    assert.equal(detectSection("Trabalhei na empresa X por anos e fiz muitas coisas importantes"), null);
  });
});

describe("job-text", () => {
  it("separa requisitos obrigatórios de desejáveis pelo cabeçalho", () => {
    const text = "Sobre nós\nSomos legais\nRequisitos:\n• React\n• TypeScript\nDiferenciais:\n• Next.js\nBenefícios:\n• Vale refeição";
    const r = extractRequirements(text);
    assert.deepEqual(r.required, ["React", "TypeScript"]);
    assert.deepEqual(r.desirable, ["Next.js"]);
  });
  it("só aceita e-mail de candidatura com contexto explícito", () => {
    assert.equal(findApplicationEmail("Dúvidas sobre privacidade: dpo@empresa.com"), null);
    assert.equal(findApplicationEmail("Fale com a gente: contato@empresa.com"), null);
    assert.equal(findApplicationEmail("Envie seu currículo para vagas@empresa.com")?.email, "vagas@empresa.com");
    assert.equal(findApplicationEmail("Apply by sending your resume to Jobs@Example.com")?.email, "jobs@example.com");
  });
  it("gera a mesma chave canônica para a mesma vaga em fontes diferentes", () => {
    const a = jobCanonicalKey({ company: "Acme Ltda.", title: "Desenvolvedor Front-end (Remoto)", url: "https://a.com/1" });
    const b = jobCanonicalKey({ company: "ACME LTDA", title: "Desenvolvedor Front-End remoto", url: "https://b.com/2" });
    assert.equal(a, b);
    assert.notEqual(a, jobCanonicalKey({ company: "Acme", title: "Backend", url: "https://a.com/3" }));
  });
  it("neutraliza injeção de fórmula no CSV e de cabeçalho no e-mail", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvCell("+1"), "\"'+1\"");
    assert.equal(sanitizeHeader("Assunto\r\nBcc: alguem@x.com"), "Assunto Bcc: alguem@x.com");
    assert.equal(isValidEmail("a@b.com\r\nCc: x@y.com"), false);
    assert.equal(isValidEmail("a@b.com"), true);
  });
  it("converte texto em HTML escapado", () => {
    assert.equal(textToHtml("Olá <b>\n\nx & y"), "<p>Olá &lt;b&gt;</p>\n<p>x &amp; y</p>");
    assert.equal(htmlToText("<p>Oi</p><ul><li>a</li><li>b &amp; c</li></ul>"), "Oi\n• a\n• b & c");
  });
});
