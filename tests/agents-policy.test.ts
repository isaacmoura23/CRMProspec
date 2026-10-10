import { describe, it, beforeEach, before } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/store";
import { normalizeNicheAnalystConfig, normalizeProspectorConfig } from "@/agents/config";
import { registerAgentHandlers } from "@/agents/registry";
import { decideApproval, expireApprovals, submitPlannedTask } from "@/services/agents/approvals";
import { dayKey, recordSpend, spentToday } from "@/services/agents/log";
import { planAgents } from "@/services/agents/planner";
import { enqueueAgentTask, runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { housekeeping, runnerTick, startAgentRunner } from "@/services/agents/runner";
import {
  getNicheAnalystConfig,
  getProspectorConfig,
  isGloballyEnabled,
  runnableAgents,
  saveSettings,
  setGloballyEnabled,
} from "@/services/agents/settings";
import type { PlannedTask } from "@/agents/types";
import { emptyAgentData } from "@/types/agents";

before(() => {
  // Sem chave do Google: a fonte é o diretório de demonstração, determinístico o bastante.
  delete process.env.GOOGLE_PLACES_API_KEY;
  registerAgentHandlers();
});

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
}

const planned = (over: Partial<PlannedTask> = {}): PlannedTask => ({
  agent: "prospector",
  kind: "prospect.run",
  payload: { niche: "imobiliaria", city: "Curitiba" },
  dedupeKey: "prospect:imobiliaria:curitiba:hoje",
  title: "Prospectar",
  detail: "",
  ...over,
});

describe("configuração: valores sempre limitados", () => {
  it("preenche o que falta e corrige o que está fora da faixa", () => {
    const n = normalizeNicheAnalystConfig({ sample_size: 9999, probe_sites: -4, cities: [{ city: "X" }, { city: "Curitiba" }, { city: "curitiba" }] });
    assert.equal(n.sample_size, 60);
    assert.equal(n.probe_sites, 0);
    assert.deepEqual(n.cities.map((c) => c.city), ["Curitiba"], "cidade curta e repetida saem");
    assert.equal(n.max_places_requests_day, 40);

    const p = normalizeProspectorConfig({ quantity_per_run: 0, daily_leads_cap: "abc" });
    assert.equal(p.quantity_per_run, 1);
    assert.equal(p.daily_leads_cap, 40);
    assert.deepEqual(p.filters, { weakWebsite: true, activeBusiness: true }, "o alvo padrão é sem site ou site fraco");
  });

  it("lixo gravado na linha de configuração não chega ao agente", () => {
    const p = normalizeProspectorConfig({ filters: { weakWebsite: "sim", hasEmail: true, inventado: true } });
    assert.deepEqual(p.filters, { hasEmail: true });
    assert.deepEqual(normalizeNicheAnalystConfig(null).cities, []);
  });
});

describe("interruptor geral e modos", () => {
  beforeEach(reset);

  it("por padrão está ligado e cada agente nasce em aprovação", async () => {
    assert.equal(await isGloballyEnabled(), true);
    assert.deepEqual(await runnableAgents(), ["niche-analyst", "prospector"]);
  });

  it("desligar o geral para todos; pausar um agente tira só ele", async () => {
    await saveSettings("prospector", { mode: "pausado" });
    assert.deepEqual(await runnableAgents(), ["niche-analyst"]);
    await setGloballyEnabled(false);
    assert.deepEqual(await runnableAgents(), []);
    await setGloballyEnabled(true);
    assert.deepEqual(await runnableAgents(), ["niche-analyst"]);
  });

  it("tarefa de agente pausado fica na fila e o runner não a executa", async () => {
    let ran = false;
    const { registerAgentHandler } = await import("@/services/agents/queue");
    registerAgentHandler("t.paused-run", async () => {
      ran = true;
    });
    await saveSettings("prospector", { mode: "pausado" });
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.paused-run" });
    await runnerTick({ ticking: false, lastPlanAt: Date.now(), lastHousekeepingAt: Date.now() });
    assert.equal(ran, false);
    assert.equal((await agentRepo().get("tasks", task.id))?.status, "pendente");

    await saveSettings("prospector", { mode: "automatico" });
    await runnerTick({ ticking: false, lastPlanAt: Date.now(), lastHousekeepingAt: Date.now() });
    assert.equal(ran, true);
  });
});

describe("consumo diário", () => {
  beforeEach(reset);

  it("soma por agente, tipo e dia", async () => {
    await recordSpend("prospector", "leads", 5);
    await recordSpend("prospector", "leads", 3);
    await recordSpend("prospector", "places_requests", 7);
    await recordSpend("niche-analyst", "leads", 100);
    await recordSpend("prospector", "leads", 0);
    assert.equal(await spentToday("prospector", "leads"), 8);
    assert.equal(await spentToday("prospector", "places_requests"), 7);
    // consumo de ontem não entra na conta de hoje
    getAgentData().spend.push({ id: "old", organization_id: getDb().organization.id, agent: "prospector", kind: "leads", amount: 50, note: null, day: "2020-01-01", created_at: "2020-01-01T10:00:00.000Z" });
    assert.equal(await spentToday("prospector", "leads"), 8);
    assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("aprovação", () => {
  beforeEach(reset);

  it("em aprovação, a proposta vira pedido e nada executa; em automático, enfileira; pausado ignora", async () => {
    assert.equal(await submitPlannedTask(planned(), "aprovacao"), "approval");
    assert.equal(getAgentData().tasks.length, 0, "nenhuma tarefa antes do clique");
    assert.equal(getAgentData().approvals.length, 1);

    assert.equal(await submitPlannedTask(planned({ dedupeKey: "outra" }), "automatico"), "enqueued");
    assert.equal(getAgentData().tasks.length, 1);

    assert.equal(await submitPlannedTask(planned({ dedupeKey: "terceira" }), "pausado"), "skipped");
  });

  it("não repete a mesma proposta no mesmo dia, nem depois de recusada", async () => {
    assert.equal(await submitPlannedTask(planned(), "aprovacao"), "approval");
    assert.equal(await submitPlannedTask(planned(), "aprovacao"), "skipped");
    const id = getAgentData().approvals[0]!.id;
    assert.equal((await decideApproval(id, false, "user_1")).ok, true);
    assert.equal(await submitPlannedTask(planned(), "aprovacao"), "skipped");
    assert.equal(getAgentData().tasks.length, 0, "recusar não enfileira");
  });

  it("aprovar enfileira a tarefa certa, com quem aprovou, e só uma vez", async () => {
    await submitPlannedTask(planned(), "aprovacao");
    const id = getAgentData().approvals[0]!.id;
    const r = await decideApproval(id, true, "user_1");
    assert.equal(r.ok, true);
    const tasks = getAgentData().tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.kind, "prospect.run");
    assert.equal(tasks[0]!.created_by, "user_1");
    assert.deepEqual(tasks[0]!.payload, { niche: "imobiliaria", city: "Curitiba" });
    assert.equal(getAgentData().approvals[0]!.task_id, tasks[0]!.id);

    const again = await decideApproval(id, true, "user_1");
    assert.equal(again.ok, false);
    assert.equal(getAgentData().tasks.length, 1, "decidir de novo não duplica");
  });

  it("pedido expirado não pode ser aprovado", async () => {
    await submitPlannedTask(planned(), "aprovacao");
    const a = getAgentData().approvals[0]!;
    a.expires_at = new Date(Date.now() - 1_000).toISOString();
    const r = await decideApproval(a.id, true, "user_1");
    assert.equal(r.ok, false);
    assert.equal(getAgentData().tasks.length, 0);
    assert.equal(getAgentData().approvals[0]!.status, "expirado");
  });

  it("expireApprovals marca os antigos", async () => {
    await submitPlannedTask(planned(), "aprovacao");
    getAgentData().approvals[0]!.expires_at = new Date(Date.now() - 1_000).toISOString();
    assert.equal(await expireApprovals(), 1);
    assert.equal(getAgentData().approvals[0]!.status, "expirado");
  });
});

describe("planejador", () => {
  beforeEach(reset);

  it("sem cidade configurada o Analista de Nicho não propõe nada", async () => {
    const r = await planAgents();
    assert.deepEqual(r, { enqueued: 0, approvals: 0 });
  });

  it("em aprovação propõe uma análise e não empilha propostas do mesmo agente", async () => {
    await saveSettings("niche-analyst", { config: { cities: [{ city: "Curitiba", country: "Brasil" }] } });
    const first = await planAgents();
    assert.equal(first.approvals, 1);
    const second = await planAgents();
    assert.equal(second.approvals, 0, "uma proposta pendente por agente");
    assert.equal(getAgentData().approvals.length, 1);
    assert.equal(getAgentData().tasks.length, 0);
  });

  it("interruptor geral desligado: nada é planejado", async () => {
    await saveSettings("niche-analyst", { mode: "automatico", config: { cities: [{ city: "Curitiba", country: "Brasil" }] } });
    await setGloballyEnabled(false);
    assert.deepEqual(await planAgents(), { enqueued: 0, approvals: 0 });
    assert.equal(getAgentData().tasks.length, 0);
  });
});

describe("Agente 1 e Agente 2 de ponta a ponta (fonte de demonstração)", () => {
  beforeEach(reset);

  it("o Analista de Nicho sem cidade falha com a causa em vez de rodar à toa", async () => {
    const { task } = await enqueueAgentTask({ agent: "niche-analyst", kind: "niche.analyze" });
    await runAgentQueue({ agents: ["niche-analyst"], budgetMs: 10_000 });
    const row = (await agentRepo().get("tasks", task.id))!;
    assert.equal(row.status, "falhou");
    assert.match(row.last_error ?? "", /cidade/i);
  });

  it("analisa os nichos pedidos, ranqueia com fatores e preserva fixar/banir numa nova análise", async () => {
    await saveSettings("niche-analyst", {
      config: { cities: [{ city: "Curitiba", country: "Brasil" }], niches: ["imobiliaria", "clinica"], sample_size: 10, probe_sites: 0 },
    });
    const { task } = await enqueueAgentTask({ agent: "niche-analyst", kind: "niche.analyze" });
    await runAgentQueue({ agents: ["niche-analyst"], budgetMs: 20_000 });

    const done = (await agentRepo().get("tasks", task.id))!;
    assert.equal(done.status, "concluido");
    assert.equal((done.result as { analyzed: number }).analyzed, 2);

    const targets = await agentRepo().list("niche_targets");
    assert.equal(targets.length, 2);
    for (const t of targets) {
      assert.ok(t.score >= 0 && t.score <= 100);
      assert.ok(t.factors.length >= 4, "fatores publicados");
      assert.equal(t.source, "diretorio", "dados de demonstração são declarados como tais");
      assert.ok(t.valid_until > t.analyzed_at);
    }

    const imob = targets.find((t) => t.niche === "imobiliaria")!;
    await agentRepo().update("niche_targets", imob.id, { status: "fixado" });
    const again = await enqueueAgentTask({ agent: "niche-analyst", kind: "niche.analyze" });
    await runAgentQueue({ agents: ["niche-analyst"], budgetMs: 20_000 });
    assert.equal((await agentRepo().get("tasks", again.task.id))?.status, "concluido");
    assert.equal((await agentRepo().get("niche_targets", imob.id))?.status, "fixado", "reanalisar não desfaz a escolha do dono");
    assert.equal((await agentRepo().list("niche_targets")).length, 2, "atualiza em vez de duplicar");
  });

  it("o Prospectador cria leads sem site ou com site fraco, na campanha do agente, e registra o consumo", async () => {
    await saveSettings("prospector", { config: { quantity_per_run: 6, daily_leads_cap: 50 } });
    const { task } = await enqueueAgentTask({
      agent: "prospector",
      kind: "prospect.run",
      payload: { niche: "imobiliaria", niche_label: "Imobiliária", city: "Londrina", country: "Brasil" },
    });
    await runAgentQueue({ agents: ["prospector"], budgetMs: 60_000 });

    const row = (await agentRepo().get("tasks", task.id))!;
    assert.equal(row.status, "concluido", row.last_error ?? "");
    const result = row.result as { found: number; job_id: string };
    assert.equal(result.found, 6);

    const db = getDb();
    const campaign = db.campaigns.find((c) => c.name === "AgentOS · Imobiliária · Londrina");
    assert.ok(campaign, "campanha do agente criada");
    const leads = db.leads.filter((l) => l.campaign_id === campaign!.id);
    assert.equal(leads.length, 6);
    assert.ok(
      leads.every((l) => !l.has_website || l.website_quality === "ruim" || l.website_quality === "desatualizado"),
      "todos com presença web fraca"
    );
    assert.equal(await spentToday("prospector", "leads"), 6);
  });

  it("o teto diário de leads corta a quantidade e, esgotado, adia a tarefa para amanhã", async () => {
    await saveSettings("prospector", { config: { quantity_per_run: 10, daily_leads_cap: 4 } });
    const payload = { niche: "clinica", niche_label: "Clínica", city: "Maringá", country: "Brasil" };
    const first = await enqueueAgentTask({ agent: "prospector", kind: "prospect.run", payload });
    await runAgentQueue({ agents: ["prospector"], budgetMs: 60_000 });
    assert.equal((first.task && (await agentRepo().get("tasks", first.task.id))!.result as { found: number }).found, 4, "cortou em 4");
    assert.equal(await spentToday("prospector", "leads"), 4);

    const second = await enqueueAgentTask({ agent: "prospector", kind: "prospect.run", payload: { ...payload, city: "Cascavel" } });
    const report = await runAgentQueue({ agents: ["prospector"], budgetMs: 60_000 });
    assert.equal(report.rescheduled, 1);
    const row = (await agentRepo().get("tasks", second.task.id))!;
    assert.equal(row.status, "pendente");
    assert.ok(row.next_run_at > new Date().toISOString(), "adiada para o dia seguinte");
    assert.equal(row.attempts, 0);
    assert.equal(await spentToday("prospector", "leads"), 4, "nada além do teto");
    assert.equal((await getProspectorConfig()).daily_leads_cap, 4);
  });

  it("o planejador do Prospectador escolhe o nicho de maior score, respeita fixado, banido e carência", async () => {
    const org = getDb().organization.id;
    const base = {
      organization_id: org,
      niche_label: "x",
      state: null,
      country: "Brasil",
      metrics: { total: 1, no_site: 1, with_site: 0, sites_sampled: 0, weak_sites: 0, with_phone: 1, with_reviews: 1 },
      factors: [],
      evidence: [],
      source: "google_places",
      analyzed_at: new Date().toISOString(),
      valid_until: new Date(Date.now() + 86_400_000).toISOString(),
      task_id: null,
    };
    const repo = agentRepo();
    await repo.insert("niche_targets", { ...base, id: "t1", niche: "clinica", city: "Curitiba", score: 80, status: "auto" });
    await repo.insert("niche_targets", { ...base, id: "t2", niche: "advogado", city: "Curitiba", score: 60, status: "fixado" });
    await repo.insert("niche_targets", { ...base, id: "t3", niche: "hotel", city: "Curitiba", score: 95, status: "banido" });
    await repo.insert("niche_targets", { ...base, id: "t4", niche: "pousada", city: "Curitiba", score: 10, status: "auto" });

    const { prospector } = await import("@/agents/prospector/agent");
    const plan = await prospector.plan();
    assert.deepEqual(plan.map((p) => p.payload.niche), ["advogado", "clinica"], "fixado primeiro; banido e abaixo da nota mínima ficam de fora");

    // concluiu há pouco: entra em carência
    const done = await enqueueAgentTask({ agent: "prospector", kind: "prospect.run", payload: { niche: "advogado", city: "Curitiba" } });
    await repo.update("tasks", done.task.id, { status: "concluido", finished_at: new Date().toISOString() });
    assert.deepEqual((await prospector.plan()).map((p) => p.payload.niche), ["clinica"]);
  });
});

describe("runner", () => {
  beforeEach(reset);

  it("não sobe em ambiente de teste nem na Vercel", () => {
    const r = startAgentRunner();
    assert.equal(r.started, false);
  });

  it("uma passada planeja e executa: em automático, a análise sai sozinha", async () => {
    await saveSettings("niche-analyst", {
      mode: "automatico",
      config: { cities: [{ city: "Curitiba", country: "Brasil" }], niches: ["restaurante"], sample_size: 5, probe_sites: 0 },
    });
    const s = { ticking: false, lastPlanAt: 0, lastHousekeepingAt: Date.now() };
    await runnerTick(s);
    assert.equal(s.ticking, false);
    assert.equal((await agentRepo().list("niche_targets")).length, 1);
    assert.ok(getAgentData().events.some((e) => e.type === "task.completed"));
  });

  it("uma passada não se sobrepõe a outra", async () => {
    const s = { ticking: true, lastPlanAt: 0, lastHousekeepingAt: 0 };
    await runnerTick(s);
    assert.equal(s.lastPlanAt, 0, "ignorada: já havia uma em curso");
  });

  it("a limpeza remove log, consumo e batimentos antigos e mantém o recente", async () => {
    const org = getDb().organization.id;
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const repo = agentRepo();
    await repo.insert("events", { id: "e-old", organization_id: org, agent: "sistema", level: "info", type: "x", message: "velho", data: null, task_id: null, created_at: old });
    await repo.insert("events", { id: "e-new", organization_id: org, agent: "sistema", level: "info", type: "x", message: "novo", data: null, task_id: null, created_at: new Date().toISOString() });
    await housekeeping();
    const ids = (await repo.list("events")).map((e) => e.id);
    assert.deepEqual(ids, ["e-new"]);
    assert.equal((await getNicheAnalystConfig()).max_places_requests_day, 40);
  });
});
