import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NICHE_WEIGHTS, isPriorityNiche, scoreNiche, type NicheScoreInput } from "@/agents/niche/scoring";
import { filterWarnings, isWeakWebsite, matchesFilters, rejectionReasons } from "@/services/lead-filter";
import type { RawLead } from "@/types";

function input(over: Partial<NicheScoreInput> = {}, metrics: Partial<NicheScoreInput["metrics"]> = {}): NicheScoreInput {
  return {
    metrics: { total: 20, no_site: 10, with_site: 10, sites_sampled: 5, weak_sites: 2, with_phone: 18, with_reviews: 16, ...metrics },
    sampleRequested: 20,
    nicheKey: "clinica",
    nicheLabel: "Clínica",
    priorityNiches: [],
    source: "google_places",
    ...over,
  };
}

describe("score de nicho", () => {
  it("soma fatores publicados e nunca passa de 100", () => {
    const r = scoreNiche(input({ priorityNiches: ["clinica"] }, { no_site: 20, with_site: 0, with_phone: 20, with_reviews: 20, sites_sampled: 0, weak_sites: 0 }));
    assert.equal(r.score, 100);
    const sum = r.factors.reduce((s, f) => s + f.points, 0);
    assert.equal(sum, r.score);
    assert.equal(r.factors.reduce((s, f) => s + f.max, 0), 100);
  });

  it("a lacuna digital conta quem não tem site e a taxa medida de sites fracos", () => {
    // 10 sem site + 10 com site × (2 de 5 fracos = 40%) = 14/20 = 70% → 28 de 40
    const gap = scoreNiche(input()).factors.find((f) => f.label === "Lacuna digital")!;
    assert.equal(gap.points, Math.round(0.7 * NICHE_WEIGHTS.gap));
    assert.match(gap.note, /50% sem site/);
    assert.match(gap.note, /2 de 5 sites visitados/);
  });

  it("sem sites visitados, a qualidade não é inventada: só quem não tem site conta, e a nota avisa", () => {
    const r = scoreNiche(input({}, { sites_sampled: 0, weak_sites: 0 }));
    const gap = r.factors.find((f) => f.label === "Lacuna digital")!;
    assert.equal(gap.points, Math.round(0.5 * NICHE_WEIGHTS.gap));
    assert.match(gap.note, /não foi medida/);
  });

  it("amostra escassa reduz a nota de mercado ativo", () => {
    const cheio = scoreNiche(input()).factors.find((f) => f.label === "Mercado ativo")!;
    const escasso = scoreNiche(input({ sampleRequested: 60 }, { total: 6, no_site: 3, with_site: 3, with_phone: 6, with_reviews: 6, sites_sampled: 0 })).factors.find((f) => f.label === "Mercado ativo")!;
    assert.ok(escasso.points < cheio.points);
    assert.match(escasso.note, /poucas empresas/);
  });

  it("aderência: prioritário vale cheio, fora da lista zero, sem lista é neutro", () => {
    const fit = (priority: string[]) => scoreNiche(input({ priorityNiches: priority })).factors.find((f) => f.label.startsWith("Aderência"))!.points;
    assert.equal(fit(["Clínica"]), 20, "casa pelo rótulo, sem acento nem caixa");
    assert.equal(fit(["advogado"]), 0);
    assert.equal(fit([]), 10);
    assert.equal(isPriorityNiche("loja_roupas", "Loja de roupas", ["loja roupas"]), true);
  });

  it("tendência de busca aparece como não avaliada, sem pontos", () => {
    const t = scoreNiche(input()).factors.find((f) => f.label === "Tendência de busca")!;
    assert.equal(t.points, 0);
    assert.equal(t.max, 0);
    assert.match(t.note, /não avaliada/);
  });

  it("fonte vazia dá zero explicado, e demonstração é declarada como tal", () => {
    const vazio = scoreNiche(input({}, { total: 0, no_site: 0, with_site: 0, with_phone: 0, with_reviews: 0, sites_sampled: 0 }));
    assert.equal(vazio.score, 0);
    assert.ok(vazio.factors.every((f) => f.points === 0));
    const demo = scoreNiche(input({ source: "diretorio" }));
    assert.match(demo.evidence[0]!.value, /demonstração/);
  });
});

function raw(over: Partial<RawLead>): RawLead {
  return { company_name: "X", segment: "s", country: "Brasil", city: "C", source: "google_places", ...over };
}

describe("filtro 'sem site ou site fraco' (weakWebsite)", () => {
  const filters = { weakWebsite: true };

  it("aceita sem site, site ruim e site desatualizado; recusa site bom e site não medido", () => {
    assert.equal(matchesFilters(raw({}), filters), true);
    assert.equal(matchesFilters(raw({ website: "http://a.wixsite.com", website_quality: "ruim" }), filters), true);
    assert.equal(matchesFilters(raw({ website: "https://a.com", website_quality: "desatualizado" }), filters), true);
    assert.equal(matchesFilters(raw({ website: "https://a.com", website_quality: "bom" }), filters), false);
    assert.equal(matchesFilters(raw({ website: "https://a.com", website_quality: "desconhecido" }), filters), false);
  });

  it("isWeakWebsite concorda com o filtro", () => {
    assert.equal(isWeakWebsite({ website: undefined, website_quality: "nenhum" }), true);
    assert.equal(isWeakWebsite({ website: "https://a.com", website_quality: "bom" }), false);
  });

  it("explica o motivo do descarte e combina com os demais critérios", () => {
    assert.deepEqual(rejectionReasons(raw({ website: "https://a.com", website_quality: "bom" }), filters), ["weakWebsite"]);
    assert.equal(matchesFilters(raw({ phone: "+55 41 99999-9999" }), { weakWebsite: true, hasPhone: true }), true);
    assert.equal(matchesFilters(raw({}), { weakWebsite: true, hasPhone: true }), false);
  });

  it("'Sem site' e 'Site ruim' juntos continuam se excluindo — por isso o OU é um critério à parte", () => {
    assert.equal(matchesFilters(raw({}), { noWebsite: true, badWebsite: true }), false);
    assert.equal(matchesFilters(raw({ website: "http://a.wixsite.com", website_quality: "ruim" }), { noWebsite: true, badWebsite: true }), false);
    assert.ok(filterWarnings({ weakWebsite: true, noWebsite: true }).some((w) => w.includes("já cobre")));
  });
});
