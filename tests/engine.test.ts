import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeResumeHeuristic, extractProfileHeuristic, guardSuggestion } from "@/services/career/analysis-engine";
import { computeMatch } from "@/services/career/matching";
import { buildMessageData, renderApplicationMessage, renderTemplate, DEFAULT_BODY, DEFAULT_SUBJECT } from "@/services/career/messaging";
import type { CareerPreferences, CareerProfile, JobPosting, ResumeLink, ResumePage } from "@/types/career";

const PAGES: ResumePage[] = [
  {
    page: 1,
    text: [
      "Maria Silva",
      "Desenvolvedora Front-end Pleno",
      "São Paulo - SP · maria@exemplo.com · +55 11 91234-5678",
      "Resumo",
      "Desenvolvedora com foco em React e TypeScript.",
      "Experiência",
      "Desenvolvedora Front-end | Loja X — mar/2021 – atual",
      "Responsável por manutenção do e-commerce em React.",
      "Reduzi o tempo de carregamento em 40% com code splitting.",
      "Estagiária | Agência Y — 2019 - 2020",
      "Atuei em landing pages com HTML e CSS.",
      "Formação",
      "Bacharelado em Sistemas de Informação — Universidade Z — 2016 - 2020",
      "Habilidades",
      "React, TypeScript, Next.js, Git, SQL",
      "Idiomas",
      "Português nativo, Inglês avançado",
    ].join("\n"),
  },
];
const LINKS: ResumeLink[] = [{ url: "https://github.com/maria", page: 1, origin: "anotacao" }];

function profileFrom(): CareerProfile {
  const d = extractProfileHeuristic(PAGES, LINKS);
  return { id: "p1", owner_id: "u1", organization_id: "o1", resume_version_id: "v1", ...d, confirmed: true, extraction_model: "test", created_at: "", updated_at: "" };
}

describe("extração heurística", () => {
  it("encontra nome, contato, título, experiências, habilidades e idiomas sem inventar", () => {
    const p = extractProfileHeuristic(PAGES, LINKS);
    assert.equal(p.full_name, "Maria Silva");
    assert.equal(p.email, "maria@exemplo.com");
    assert.ok(p.phone?.includes("91234"));
    assert.equal(p.headline, "Desenvolvedora Front-end Pleno");
    assert.equal(p.experiences.length, 2);
    assert.equal(p.experiences[0]?.start, "2021-03");
    assert.equal(p.experiences[0]?.end, null);
    assert.ok(p.skills.map((s) => s.toLowerCase()).includes("react"));
    assert.ok(p.languages.some((l) => l.startsWith("ingl")));
    assert.deepEqual(p.links, ["https://github.com/maria"]);
  });
});

describe("análise heurística", () => {
  it("produz nota, critérios com pesos que somam 100 e sugestões com trecho original", () => {
    const p = extractProfileHeuristic(PAGES, LINKS);
    const a = analyzeResumeHeuristic(PAGES, LINKS, p, { llmAvailable: false, layoutAvailable: false });
    assert.ok(a.score !== null && a.score > 0 && a.score <= 100);
    assert.equal(a.criteria.reduce((s, c) => s + c.weight, 0), 100);
    assert.ok(a.not_evaluated.some((n) => /Layout/.test(n)));
    const weak = a.suggestions.find((s) => s.original.startsWith("Responsável por"));
    assert.ok(weak, "sugestão para bullet fraco");
    assert.equal(weak!.needs_user_input, true);
    for (const s of a.suggestions) assert.ok(PAGES[0]!.text.includes(s.original), `original literal: ${s.original}`);
  });
});

describe("guardSuggestion (anti-invenção)", () => {
  const full = PAGES[0]!.text;
  it("rejeita trecho que não existe no currículo", () => {
    assert.equal(guardSuggestion({ original: "Liderei time de 10 pessoas", suggested: "x", problem: "p", rationale: "r", priority: "alta" }, full), null);
  });
  it("rejeita números novos no texto sugerido", () => {
    assert.equal(guardSuggestion({ original: "Atuei em landing pages com HTML e CSS.", suggested: "Entreguei 25 landing pages com HTML e CSS.", problem: "p", rationale: "r", priority: "alta" }, full), null);
  });
  it("aceita reescrita sem dados novos e marca lacunas entre colchetes", () => {
    const s = guardSuggestion({ original: "Atuei em landing pages com HTML e CSS.", suggested: "Desenvolvi landing pages em HTML e CSS para [número de clientes] clientes.", problem: "p", rationale: "r", priority: "media" }, full);
    assert.ok(s);
    assert.equal(s!.needs_user_input, true);
    const ok = guardSuggestion({ original: "Reduzi o tempo de carregamento em 40% com code splitting.", suggested: "Reduzi em 40% o tempo de carregamento aplicando code splitting.", problem: "p", rationale: "r", priority: "baixa" }, full);
    assert.ok(ok && ok.needs_user_input === false);
  });
});

const JOB: JobPosting = {
  id: "j1", owner_id: "u1", organization_id: "o1", source: "demo", external_id: "1", canonical_key: "acme|front",
  title: "Desenvolvedora Front-end", company: "Acme",
  description: "Requisitos:\n• React\n• TypeScript\n• Docker\nDesejável:\n• Next.js\n• Comunicação",
  requirements: ["React", "TypeScript", "Docker"], location: "São Paulo, SP", work_mode: "hibrido", url: "https://acme.example/1", apply_url: null,
  application_email: "vagas@acme.example", application_email_evidence: "x", salary: null, contract_type: null, language: "pt",
  posted_at: new Date().toISOString(), collected_at: new Date().toISOString(), expires_at: null, status: "aberta", status_checked_at: null, origin_evidence: "t",
};

describe("matching explicável", () => {
  it("lista atendidos, lacunas e desconhecidos; desejável pesa menos", () => {
    const m = computeMatch(profileFrom(), null, JOB);
    assert.ok(m.met.some((x) => x === "React"));
    assert.ok(m.gaps.some((x) => x === "Docker"));
    assert.ok(m.met.some((x) => x.includes("Next.js")));
    assert.ok(m.unknown.some((x) => x.includes("Comunicação")) || m.gaps.every((g) => !g.includes("Comunicação")));
    assert.ok(m.score > 40 && m.score < 100, String(m.score));
    assert.equal(m.blocked_by.length, 0);
  });
  it("restrições obrigatórias zeram a nota (empresa excluída, modalidade)", () => {
    const prefs: CareerPreferences = { owner_id: "u1", organization_id: "o1", desired_roles: [], locations: [], work_modes: ["remoto"], languages: [], contract_types: [], min_salary: null, currency: "BRL", excluded_companies: ["acme"], min_match_score: 60, candidate_email: null, updated_at: "" };
    const m = computeMatch(profileFrom(), prefs, JOB);
    assert.equal(m.score, 0);
    assert.equal(m.blocked_by.length, 2);
  });
});

describe("mensagem de candidatura", () => {
  it("omite frases sem dado e nunca deixa placeholder", () => {
    const out = renderTemplate("Olá {{empresa}}. Meu {{portfolio_ou_perfil}} está em {{link_verificado}}. Tchau.", { empresa: "Acme", portfolio_ou_perfil: null, link_verificado: null });
    assert.equal(out, "Olá Acme. Tchau.");
    assert.throws(() => renderTemplate("{{desconhecido", { a: "b" }));
  });
  it("renderiza o modelo padrão só com dados reais do perfil e da vaga", () => {
    const profile = profileFrom();
    const data = buildMessageData(profile, JOB, computeMatch(profile, null, JOB) as never);
    assert.equal(data.nome, "Maria Silva");
    assert.equal(data.resultado_documentado, null); // sem métrica na primeira experiência? o engine pega a primeira linha com número
    const msg = renderApplicationMessage({ subject: DEFAULT_SUBJECT, body: DEFAULT_BODY }, profile, JOB, null);
    assert.doesNotMatch(msg.body_text, /\{\{|\}\}/);
    assert.match(msg.subject, /^Candidatura para Desenvolvedora Front-end — Maria Silva$/);
    assert.match(msg.body_text, /Acme/);
    assert.match(msg.body_html, /^<p>/);
    assert.doesNotMatch(msg.subject, /[\r\n]/);
  });
});
