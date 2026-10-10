import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/store";
import { normalizeProspectorConfig } from "@/agents/config";
import { registerAgentHandlers } from "@/agents/registry";
import { prospector, recordCoverage, sweepCells, SWEEP_FILTERS } from "@/agents/prospector/agent";
import { BR_CAPITALS, BR_LARGE_CITIES, citySlug, scopeCities } from "@/data/br-cities";
import { enqueueAgentTask, runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { saveSettings } from "@/services/agents/settings";
import { coverageSummary, prospectCsv, prospectRows } from "@/services/prospecting/list";
import { emptyAgentData } from "@/types/agents";

const NOW = new Date("2026-10-12T15:00:00Z");

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  const db = getDb();
  db.leads.splice(0);
  db.campaigns.splice(0);
  db.lead_analysis.splice(0);
  db.activities.splice(0);
}

const target = (niche: string, score: number, over: Record<string, unknown> = {}) => ({
  id: `t_${niche}`,
  organization_id: getDb().organization.id,
  niche,
  niche_label: niche,
  city: "Curitiba",
  state: null,
  country: "Brasil",
  score,
  status: "auto" as const,
  metrics: { total: 1, no_site: 1, with_site: 0, sites_sampled: 0, weak_sites: 0, with_phone: 1, with_reviews: 1 },
  factors: [],
  evidence: [],
  source: "google_places",
  analyzed_at: NOW.toISOString(),
  valid_until: new Date(NOW.getTime() + 86_400_000).toISOString(),
  task_id: null,
  ...over,
});

beforeEach(() => {
  registerAgentHandlers();
  reset();
});

describe("cidades da varredura", () => {
  it("as 27 capitais e as grandes cidades são únicas, com UF válida e sem sobreposição", () => {
    assert.equal(BR_CAPITALS.length, 27);
    assert.ok(BR_CAPITALS.every((c) => c.capital));
    const UF = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
    const all = [...BR_CAPITALS, ...BR_LARGE_CITIES];
    assert.ok(all.every((c) => UF.has(c.state)), "UF inválida");
    assert.equal(new Set(all.map((c) => `${c.city}|${c.state}`)).size, all.length, "cidade repetida");
    assert.equal(new Set(all.map((c) => citySlug(c.city))).size, all.length, "slug repetido");
    assert.equal(scopeCities("capitais").length, 27);
    assert.equal(scopeCities("principais").length, all.length);
    assert.ok(all.length >= 100);
    assert.equal(citySlug("São José do Rio Preto"), "sao-jose-do-rio-preto");
  });

  it("a varredura vem desligada por padrão e a configuração é saneada", () => {
    const d = normalizeProspectorConfig({});
    assert.equal(d.sweep, false);
    assert.equal(d.sweep_scope, "principais");
    assert.equal(d.sweep_niches, 3);
    const c = normalizeProspectorConfig({ sweep: "sim", sweep_scope: "mundo", sweep_niches: 99 });
    assert.equal(c.sweep, false, "só `true` liga");
    assert.equal(c.sweep_scope, "principais");
    assert.equal(c.sweep_niches, 10);
  });
});

describe("varredura: qual célula vem agora", () => {
  const cfg = { sweep_scope: "principais" as const, sweep_niches: 2, cooldown_days: 7 };

  it("pega os nichos de maior nota do Analista e, em cada um, a primeira cidade nunca varrida (capitais antes)", async () => {
    await agentRepo().insert("niche_targets", target("clinica", 90));
    await agentRepo().insert("niche_targets", target("advogado", 70));
    await agentRepo().insert("niche_targets", target("hotel", 99, { status: "banido" }));
    const cells = await sweepCells(cfg, NOW);
    assert.deepEqual(cells.map((c) => [c.niche, c.city]), [["clinica", "São Paulo"], ["advogado", "São Paulo"]], "banido fica de fora");
  });

  it("depois de varrer uma cidade passa para a próxima; dentro da carência não repete; esgotado volta à mais antiga", async () => {
    await agentRepo().insert("niche_targets", target("clinica", 90));
    const base = { niche: "clinica", niche_label: "clinica", state: "SP", country: "Brasil", scanned: 20, found: 3, filtered: 0, duplicates: 0, places_requests: 1 };
    await recordCoverage({ ...base, city: "São Paulo" }, NOW);
    assert.equal((await sweepCells({ ...cfg, sweep_niches: 1 }, NOW))[0]!.city, "Rio de Janeiro");

    // todas as cidades varridas há 1 dia (dentro da carência): nada a varrer
    for (const c of scopeCities("principais")) await recordCoverage({ ...base, city: c.city }, new Date(NOW.getTime() - 86_400_000));
    assert.deepEqual(await sweepCells({ ...cfg, sweep_niches: 1 }, NOW), []);

    // passada a carência, volta a varrer: a mais antiga primeiro
    await recordCoverage({ ...base, city: "Curitiba" }, new Date(NOW.getTime() - 20 * 86_400_000));
    const again = await sweepCells({ ...cfg, sweep_niches: 1 }, NOW);
    assert.equal(again[0]!.city, "Curitiba");
  });

  it("sem nenhuma nota do Analista ainda varre (usa os nichos que a fonte entende)", async () => {
    const cells = await sweepCells({ ...cfg, sweep_niches: 3 }, NOW);
    assert.equal(cells.length, 3);
    assert.ok(cells.every((c) => c.city === "São Paulo"));
  });

  it("o registro de cobertura soma as execuções da mesma célula", async () => {
    const base = { niche: "clinica", niche_label: "Clínica", city: "Curitiba", state: "PR", country: "Brasil", filtered: 1, duplicates: 2, places_requests: 1 };
    await recordCoverage({ ...base, scanned: 20, found: 3 }, NOW);
    const second = await recordCoverage({ ...base, scanned: 10, found: 1 }, new Date(NOW.getTime() + 1000));
    assert.equal(second.runs, 2);
    assert.equal(second.scanned, 30);
    assert.equal(second.found, 4);
    assert.equal(second.places_requests, 2);
    assert.equal((await agentRepo().list("prospect_coverage")).length, 1);
  });
});

describe("varredura: o que o agente planeja e executa", () => {
  it("desligada, só planeja os nichos do Analista; ligada, acrescenta as células com o filtro 'sem site'", async () => {
    await agentRepo().insert("niche_targets", target("clinica", 80));
    const off = await prospector.plan();
    assert.ok(off.every((p) => !p.payload.sweep));

    await saveSettings("prospector", { config: { sweep: true, sweep_niches: 1 } });
    const on = await prospector.plan();
    const sweep = on.filter((p) => p.payload.sweep);
    assert.equal(sweep.length, 1);
    assert.deepEqual(sweep[0]!.payload.filters, SWEEP_FILTERS);
    assert.equal(SWEEP_FILTERS.noWebsite, true);
    assert.equal(sweep[0]!.payload.country, "Brasil");
    assert.equal(new Set(on.map((p) => p.dedupeKey)).size, on.length, "sem tarefas repetidas");
  });

  it("teto diário de leads esgotado: nada é planejado, nem varredura", async () => {
    await saveSettings("prospector", { config: { sweep: true, daily_leads_cap: 5 } });
    const { recordSpend } = await import("@/services/agents/log");
    await recordSpend("prospector", "leads", 5);
    assert.deepEqual(await prospector.plan(), []);
  });

  it("executa uma célula da varredura (fonte de demonstração): só empresas sem site, cobertura gravada, lista pronta", async () => {
    await saveSettings("prospector", { mode: "automatico", config: { sweep: true, sweep_niches: 1, quantity_per_run: 20 } });
    const [cell] = (await prospector.plan()).filter((p) => p.payload.sweep);
    assert.ok(cell);
    await enqueueAgentTask({ agent: "prospector", kind: cell!.kind, payload: cell!.payload, dedupeKey: cell!.dedupeKey });
    await runAgentQueue({ agents: ["prospector"], budgetMs: 20_000 });
    const [task] = await agentRepo().list("tasks", { where: { kind: "prospect.run" } });
    assert.equal(task!.status, "concluido", task!.last_error ?? "");

    const coverage = await agentRepo().list("prospect_coverage");
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]!.city, cell!.payload.city);
    assert.equal(coverage[0]!.found, (task!.result as { found: number }).found);

    const rows = prospectRows();
    assert.ok(rows.length > 0, "a varredura achou empresas");
    assert.ok(rows.every((r) => !getDb().leads.find((l) => l.id === r.id)!.website), "toda empresa da lista é sem site");
    assert.ok(rows.every((r) => r.demo), "a fonte de demonstração é marcada como tal");
    const sum = await coverageSummary();
    assert.equal(sum.cells, 1);
    assert.equal(sum.found, coverage[0]!.found);
    assert.equal(sum.sweepOn, true);
    assert.ok(sum.citiesInScope >= 100);
  });
});

describe("lista de prospecção", () => {
  function lead(over: Record<string, unknown>) {
    const db = getDb();
    const base = db.leads[0] ?? null;
    void base;
    const id = `l_${db.leads.length + 1}`;
    db.leads.push({
      id,
      organization_id: db.organization.id,
      company_name: `Empresa ${id}`,
      contact_name: null,
      legal_name: null,
      segment: "Clínica",
      description: null,
      phone: "(41) 3333-4444",
      whatsapp: null,
      email: null,
      website: null,
      instagram: null,
      facebook: null,
      linkedin: null,
      google_maps_url: "https://maps.google.com/?q=x",
      country: "Brasil",
      state: "PR",
      city: "Curitiba",
      address: null,
      reviews_count: 1,
      rating: 4,
      opening_hours: null,
      source: "google_places",
      source_id: id,
      campaign_id: "cmp_agent",
      has_website: false,
      website_quality: "nenhum",
      has_whatsapp: false,
      instagram_active: false,
      marketing_signals: false,
      business_active: true,
      catalog_size: "desconhecido",
      status: "novo",
      pipeline_stage_id: null,
      stage_entered_at: null,
      lead_score: 70,
      temperature: "bom",
      potential_value: null,
      assigned_to: null,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_contact_at: null,
      next_follow_up_at: null,
      ...over,
    } as never);
    return id;
  }
  beforeEach(() => {
    getDb().campaigns.push({ id: "cmp_agent", organization_id: getDb().organization.id, name: "AgentOS · Clínica · Curitiba", description: null, created_at: new Date().toISOString(), archived: false });
  });

  it("só entra empresa sem site criada pelos agentes e não arquivada; cada linha traz telefone, Instagram e Maps", () => {
    const ok = lead({ company_name: "Aurora", instagram: "@aurora" });
    lead({ company_name: "Com site", website: "https://x.com.br" });
    lead({ company_name: "Arquivada", archived: true });
    lead({ company_name: "Manual", campaign_id: null });
    const rows = prospectRows();
    assert.deepEqual(rows.map((r) => r.name), ["Aurora"]);
    assert.equal(rows[0]!.id, ok);
    assert.equal(rows[0]!.phone, "(41) 3333-4444");
    assert.equal(rows[0]!.instagram, "@aurora");
    assert.match(rows[0]!.instagram_origin ?? "", /campo "site" da ficha do Google Maps/);
    assert.equal(rows[0]!.maps_url, "https://maps.google.com/?q=x");
    assert.equal(rows[0]!.demo, false);
  });

  it("Instagram só quando encontrado: sem ele a coluna fica vazia, sem origem inventada", () => {
    lead({ company_name: "Sem IG" });
    const [r] = prospectRows();
    assert.equal(r!.instagram, null);
    assert.equal(r!.instagram_origin, null);
  });

  it("CSV: separador ';', BOM, cabeçalho, fórmula neutralizada e link do Maps só se for http(s)", () => {
    lead({ company_name: "=HYPERLINK(\"http://golpe\")", phone: "+55 41 99999-8888", google_maps_url: "javascript:alert(1)", instagram: "@x\"y" });
    lead({ company_name: "Normal, Ltda", google_maps_url: "https://maps.google.com/?q=n" });
    const csv = prospectCsv(prospectRows());
    assert.ok(csv.startsWith("﻿empresa;telefone;instagram;origem_do_instagram;google_maps;"));
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => l.startsWith(`"'=HYPERLINK(`)), "fórmula começa com apóstrofo");
    assert.ok(!csv.includes("javascript:"));
    assert.ok(csv.includes(`"'@x""y"`), "aspas escapadas e @ inicial neutralizado");
    assert.ok(csv.includes('"Normal, Ltda"'));
  });
});
