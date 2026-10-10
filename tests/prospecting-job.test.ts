import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/store";
import { createProspectingJob } from "@/jobs/prospecting";
import type { ProspectingJob, SearchParams } from "@/types";

/**
 * Caracterização do job de prospecção com o provedor de demonstração.
 *
 * Protege o comportamento do job enquanto ele é reaproveitado pelo Agente 2:
 * a extração do miolo para `executeProspecting` não pode mudar o que a tela
 * de Prospectar entrega hoje.
 */

before(() => {
  delete process.env.GOOGLE_PLACES_API_KEY;
});

function params(over: Partial<SearchParams> = {}): SearchParams {
  return {
    niche: "imobiliaria",
    country: "Brasil",
    city: "Curitiba",
    quantity: 5,
    filters: {},
    campaignName: "Teste de caracterização",
    ...over,
  };
}

async function waitFor(job: ProspectingJob, timeoutMs = 30_000): Promise<ProspectingJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = getDb().prospecting_jobs.find((j) => j.id === job.id)!;
    if (current.status === "completed" || current.status === "failed") return current;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job não terminou a tempo");
}

describe("job de prospecção (provedor de demonstração)", () => {
  it("entrega a quantidade pedida, cria os leads na campanha e fecha todos os passos", async () => {
    const userId = getDb().users[0]!.id;
    const started = createProspectingJob(params(), userId);
    assert.equal(started.status, "queued");

    const done = await waitFor(started);
    assert.equal(done.status, "completed");
    assert.equal(done.found_lead_ids.length, 5);
    assert.ok(done.finished_at);
    assert.ok(done.steps.every((s) => s.status === "completed"), "todos os passos concluídos");

    const db = getDb();
    const campaign = db.campaigns.find((c) => c.name === "Teste de caracterização");
    assert.ok(campaign);
    const leads = db.leads.filter((l) => done.found_lead_ids.includes(l.id));
    assert.equal(leads.length, 5);
    assert.ok(leads.every((l) => l.campaign_id === campaign!.id));
    assert.ok(leads.every((l) => l.city === "Curitiba"));
    // cada lead criado recebeu análise
    assert.ok(leads.every((l) => db.lead_analysis.some((a) => a.lead_id === l.id)));

    const note = db.notifications.find((n) => n.user_id === userId && n.title.startsWith("Prospecção concluída"));
    assert.ok(note, "notificação de conclusão para quem pediu");
  });

  it("respeita o filtro 'Sem site': nenhum lead criado tem site", async () => {
    const started = createProspectingJob(params({ filters: { noWebsite: true } }), getDb().users[0]!.id);
    const done = await waitFor(started);
    assert.equal(done.status, "completed");
    const leads = getDb().leads.filter((l) => done.found_lead_ids.includes(l.id));
    assert.ok(leads.length > 0);
    assert.ok(leads.every((l) => !l.has_website));
  });

  it("não repete empresa entre buscas seguidas no mesmo nicho e cidade", async () => {
    const userId = getDb().users[0]!.id;
    const first = await waitFor(createProspectingJob(params({ campaignName: "Rodada A" }), userId));
    const second = await waitFor(createProspectingJob(params({ campaignName: "Rodada B" }), userId));
    const db = getDb();
    const firstNames = new Set(db.leads.filter((l) => first.found_lead_ids.includes(l.id)).map((l) => l.company_name));
    const repeated = db.leads.filter((l) => second.found_lead_ids.includes(l.id) && firstNames.has(l.company_name));
    assert.equal(repeated.length, 0);
  });
});
