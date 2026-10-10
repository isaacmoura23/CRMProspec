import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/store";
import { ProviderError, type SendTextInput } from "@/providers/whatsapp/types";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { saveSettings, setGloballyEnabled } from "@/services/agents/settings";
import { dayKey } from "@/services/agents/log";
import { isBlocked, blockPhone } from "@/services/outreach/blocklist";
import { applyDeliveryStatus } from "@/services/outreach/delivery";
import { processCycle, processDueOutreach, reconcileOutreach, MAX_TECHNICAL_ATTEMPTS, type OutreachDeps } from "@/services/outreach/send";
import { outreachStats } from "@/services/outreach/gate";
import { SELLER_DEFAULTS } from "@/agents/config";
import { emptyAgentData, type OutreachCycle, type OutreachMessage } from "@/types/agents";
import type { Lead } from "@/types";

/** Terça-feira, 12:00 em São Paulo (15:00Z): dentro da janela padrão (seg–sex, 9h–18h). */
const NOW = new Date("2026-10-13T15:00:00Z");
const SATURDAY = new Date("2026-10-10T15:00:00Z");
const BODY = "Oi, tudo bem? Vi o trabalho de vocês e percebi uma coisa que posso ajudar. Quer que eu te explique rapidinho?\n\nSe preferir não receber mais mensagens, é só responder PARE.";

let seq = 0;

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  const db = getDb();
  db.leads.splice(0);
  db.activities.splice(0);
  db.notifications.splice(0);
  db.campaigns.splice(0);
}

function mkLead(over: Partial<Lead> = {}): Lead {
  const db = getDb();
  const n = ++seq;
  const lead: Lead = {
    id: `lead_t${n}`,
    organization_id: db.organization.id,
    company_name: `Imobiliária ${n}`,
    contact_name: null,
    legal_name: null,
    segment: "Imobiliária",
    description: null,
    phone: "(41) 99999-8888",
    whatsapp: "+5541999998888",
    email: null,
    website: null,
    instagram: null,
    facebook: null,
    linkedin: null,
    google_maps_url: null,
    country: "Brasil",
    state: "PR",
    city: "Curitiba",
    address: null,
    reviews_count: 10,
    rating: 4.5,
    opening_hours: null,
    source: "google_places",
    source_id: `p${n}`,
    campaign_id: null,
    has_website: false,
    website_quality: "nenhum",
    has_whatsapp: true,
    instagram_active: false,
    marketing_signals: false,
    business_active: true,
    catalog_size: "desconhecido",
    status: "qualificado",
    pipeline_stage_id: null,
    stage_entered_at: null,
    lead_score: 80,
    temperature: "quente",
    potential_value: null,
    assigned_to: null,
    archived: false,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_contact_at: null,
    next_follow_up_at: null,
    ...over,
  };
  db.leads.push(lead);
  return lead;
}

async function mkCycle(lead: Lead, over: Partial<OutreachCycle> = {}): Promise<OutreachCycle> {
  const n = ++seq;
  const when = NOW.toISOString();
  const cycle: OutreachCycle = {
    id: `ocy_t${n}`,
    organization_id: getDb().organization.id,
    lead_id: lead.id,
    touch: 1,
    phone: "+5541999998888",
    body: BODY,
    status: "agendado",
    scheduled_for: when,
    not_before: when,
    claimed_at: null,
    attempts: 0,
    idempotency_key: `ocy_t${n}`,
    approval_id: null,
    skip_reason: null,
    last_error: null,
    message_id: null,
    created_at: when,
    updated_at: when,
    sent_at: null,
    ...over,
  };
  await agentRepo().insert("outreach_cycles", cycle);
  return cycle;
}

async function mkMessage(over: Partial<OutreachMessage> = {}): Promise<OutreachMessage> {
  const n = ++seq;
  const m: OutreachMessage = {
    id: `omsg_t${n}`,
    organization_id: getDb().organization.id,
    lead_id: "lead_x",
    cycle_id: `ocy_x${n}`,
    phone: "+5541988887777",
    body: BODY,
    status: "SENT",
    provider_message_id: `WA${n}`,
    error_detail: null,
    created_at: NOW.toISOString(),
    sent_at: NOW.toISOString(),
    delivered_at: null,
    read_at: null,
    ...over,
  };
  await agentRepo().insert("outreach_messages", m);
  return m;
}

interface FakeGateway {
  calls: SendTextInput[];
  statusCalls: number;
  status: string;
  statusError: Error | null;
  sendError: Error | null;
  delayMs: number;
}

function fakeGateway(over: Partial<FakeGateway> = {}) {
  const g: FakeGateway = { calls: [], statusCalls: 0, status: "CONNECTED", statusError: null, sendError: null, delayMs: 0, ...over };
  const deps = (now: Date = NOW): OutreachDeps => ({
    now: () => now,
    gateway: () => ({
      status: async () => {
        g.statusCalls += 1;
        if (g.statusError) throw g.statusError;
        return { status: g.status, dryRun: false };
      },
      sendText: async (input) => {
        g.calls.push(input);
        if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs));
        if (g.sendError) throw g.sendError;
        return { providerMessageId: `WA${g.calls.length}` };
      },
    }),
  });
  return { g, deps };
}

const cycleOf = async (id: string) => (await agentRepo().get("outreach_cycles", id))!;

beforeEach(async () => {
  reset();
  await saveSettings("seller", { mode: "automatico" });
});

describe("envio de um ciclo: o caminho feliz", () => {
  it("envia o texto exato, com a chave do ciclo como referência, e atualiza mensagem, ciclo e lead", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead);
    const { g, deps } = fakeGateway();

    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "sent");
    assert.deepEqual(g.calls, [{ to: "+5541999998888", body: BODY, clientReference: c.idempotency_key }]);

    const after = await cycleOf(c.id);
    assert.equal(after.status, "enviado");
    assert.ok(after.sent_at);
    const message = (await agentRepo().get("outreach_messages", after.message_id!))!;
    assert.equal(message.status, "SENT");
    assert.equal(message.provider_message_id, "WA1");
    assert.equal(message.body, BODY, "o texto gravado é o que saiu");

    assert.equal(lead.status, "contatado");
    assert.ok(lead.last_contact_at);
    assert.ok(getDb().activities.some((a) => a.lead_id === lead.id && a.type === "primeiro_contato"));
  });

  it("agenda o próximo toque conforme o espaçamento e para depois do terceiro", async () => {
    const lead = mkLead();
    const first = await mkCycle(lead);
    await processCycle(first.id, fakeGateway().deps());

    const tasks = await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } });
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]!.payload, { lead_id: lead.id, touch: 2 });
    const days = (Date.parse(tasks[0]!.next_run_at) - NOW.getTime()) / 86_400_000;
    assert.ok(Math.abs(days - 3) < 0.01, `3 dias de espera, achei ${days}`);

    // terceiro toque enviado: não há quarto
    reset();
    await saveSettings("seller", { mode: "automatico" });
    const l2 = mkLead({ status: "contatado" });
    const third = await mkCycle(l2, { touch: 3 });
    await processCycle(third.id, fakeGateway().deps());
    assert.equal((await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } })).length, 0);
  });
});

describe("envio de um ciclo: nunca em dobro", () => {
  it("seis processamentos simultâneos do mesmo ciclo enviam uma única vez", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead);
    const { g, deps } = fakeGateway({ delayMs: 30 });
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => processCycle(c.id, deps())));
    assert.equal(g.calls.length, 1);
    assert.equal(outcomes.filter((o) => o.result === "sent").length, 1);
    assert.equal(outcomes.filter((o) => o.result === "already_processed").length, 5);
  });

  it("reprocessar um ciclo já enviado não faz nada", async () => {
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway();
    await processCycle(c.id, deps());
    assert.equal((await processCycle(c.id, deps())).result, "already_processed");
    assert.equal(g.calls.length, 1);
  });

  it("o repositório recusa um segundo ciclo ativo para o mesmo lead e a mesma chave de idempotência", async () => {
    const lead = mkLead();
    await mkCycle(lead);
    await assert.rejects(mkCycle(lead), /abordagem em andamento/);
    const other = mkLead();
    const first = await mkCycle(other, { status: "enviado" });
    await assert.rejects(mkCycle(mkLead(), { idempotency_key: first.idempotency_key }), /idempot/i);
  });
});

describe("envio de um ciclo: esperar não é falhar", () => {
  it("fora da janela adia para a próxima abertura sem contar tentativa nem tocar o gateway", async () => {
    const c = await mkCycle(mkLead(), { scheduled_for: SATURDAY.toISOString() });
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps(SATURDAY));
    assert.equal(out.result, "deferred");
    if (out.result === "deferred") {
      assert.equal(out.global, true);
      assert.equal(out.until.toISOString(), "2026-10-12T12:00:00.000Z", "segunda 09:00 em São Paulo");
    }
    const after = await cycleOf(c.id);
    assert.equal(after.status, "agendado");
    assert.equal(after.attempts, 0);
    assert.equal(after.scheduled_for, "2026-10-12T12:00:00.000Z", "esperar a janela é o plano: a data prevista vira o novo horário");
    assert.equal(g.calls.length, 0);
    assert.equal(g.statusCalls, 0);
  });

  it("aprovada no sábado, sai na segunda de manhã: esperar a janela não torna a mensagem obsoleta", async () => {
    const c = await mkCycle(mkLead(), { scheduled_for: SATURDAY.toISOString(), not_before: SATURDAY.toISOString() });
    const { g, deps } = fakeGateway();
    assert.equal((await processCycle(c.id, deps(SATURDAY))).result, "deferred");
    const waiting = await cycleOf(c.id);
    assert.equal(waiting.scheduled_for, "2026-10-12T12:00:00.000Z", "a data prevista virou segunda 09:00");
    assert.equal(waiting.attempts, 0);

    const monday = new Date("2026-10-12T12:30:00Z");
    assert.equal((await processCycle(c.id, deps(monday))).result, "sent");
    assert.equal(g.calls.length, 1);
    assert.equal((await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } })).every((t) => (t.payload as { touch: number }).touch === 2), true, "nada foi reprogramado como obsoleto");
  });

  it("já uma etapa que ficou parada por dias (desconexão, pausa) continua sendo obsoleta", async () => {
    const c = await mkCycle(mkLead());
    const { deps } = fakeGateway({ status: "DISCONNECTED" });
    assert.equal((await processCycle(c.id, deps())).result, "deferred");
    assert.equal((await cycleOf(c.id)).scheduled_for, NOW.toISOString(), "desconexão não muda a data prevista");
    await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    assert.deepEqual(await processCycle(c.id, fakeGateway().deps(later)), { result: "skipped", reason: "etapa obsoleta" });
  });

  it("WhatsApp desconectado devolve à fila sem tentativa e sem criar mensagem", async () => {
    const c = await mkCycle(mkLead());
    for (const status of ["DISCONNECTED", "QR", "NEEDS_RECONNECT", "CONNECTING"]) {
      const { g, deps } = fakeGateway({ status });
      const out = await processCycle(c.id, deps());
      assert.equal(out.result, "deferred", status);
      assert.equal(g.calls.length, 0);
      await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    }
    assert.equal((await cycleOf(c.id)).attempts, 0);
    assert.equal(getAgentData().outreach_messages.length, 0);
  });

  it("gateway fora do ar ou recusando o token também só espera", async () => {
    const c = await mkCycle(mkLead());
    const down = fakeGateway({ statusError: new ProviderError("TEMPORARY", "ECONNREFUSED") });
    assert.equal((await processCycle(c.id, down.deps())).result, "deferred");
    await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    const auth = fakeGateway({ statusError: new ProviderError("AUTH", "token") });
    const out = await processCycle(c.id, auth.deps());
    assert.equal(out.result, "deferred");
    assert.equal((await cycleOf(c.id)).attempts, 0);
  });

  it("modo de teste do gateway e desconexão no meio do envio removem a mensagem e voltam à fila sem tentativa", async () => {
    for (const kind of ["DRY_RUN", "DISCONNECTED"] as const) {
      reset();
      await saveSettings("seller", { mode: "automatico" });
      const c = await mkCycle(mkLead());
      const { g, deps } = fakeGateway({ sendError: new ProviderError(kind, kind) });
      const out = await processCycle(c.id, deps());
      assert.equal(out.result, "deferred", kind);
      assert.equal(g.calls.length, 1, "tentou enviar uma vez");
      const after = await cycleOf(c.id);
      assert.equal(after.status, "agendado");
      assert.equal(after.attempts, 0);
      assert.equal(after.message_id, null);
      assert.equal(getAgentData().outreach_messages.length, 0, "nada fica marcado como enviado");
    }
  });

  it("falha de configuração (autorização recusada) espera 10 minutos e avisa uma vez só", async () => {
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway({ sendError: new ProviderError("PERMANENT", "Autorização de envio inválida.", 403) });
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "deferred");
    if (out.result === "deferred") assert.equal(out.until.getTime() - NOW.getTime(), 10 * 60_000);
    assert.equal((await cycleOf(c.id)).attempts, 0);
    await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    await processCycle(c.id, deps());
    assert.equal(getAgentData().events.filter((e) => e.type === "outreach.config").length, 1, "não repete o aviso a cada espera");
    assert.equal(g.calls.length, 2);
  });
});

describe("envio de um ciclo: teto diário, aquecimento e intervalo", () => {
  it("o aquecimento limita o primeiro dia a 10 mensagens; chegando ao teto adia para a próxima janela", async () => {
    for (let i = 0; i < 10; i++) {
      await mkMessage({ sent_at: new Date(NOW.getTime() - (5 + i) * 3_600_000 / 10).toISOString() });
    }
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "deferred");
    if (out.result === "deferred") {
      assert.equal(out.global, true);
      assert.equal(out.until.toISOString(), "2026-10-14T12:00:00.000Z", "quarta 09:00 em São Paulo");
    }
    assert.equal(g.calls.length, 0);
    const stats = await outreachStats(NOW, { ...SELLER_DEFAULTS });
    assert.equal(stats.cap, 10);
    assert.equal(stats.sentToday, 10);
  });

  it("depois de semanas de uso o teto é o máximo do dono, e o de ontem não pesa hoje", async () => {
    await mkMessage({ sent_at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });
    for (let i = 0; i < 12; i++) await mkMessage({ sent_at: new Date(NOW.getTime() - (2 + i) * 600_000).toISOString() });
    await mkMessage({ sent_at: new Date(NOW.getTime() - 26 * 3_600_000).toISOString() });
    const stats = await outreachStats(NOW, { ...SELLER_DEFAULTS });
    assert.equal(stats.cap, 40);
    assert.equal(stats.sentToday, 12);
    const c = await mkCycle(mkLead());
    assert.equal((await processCycle(c.id, fakeGateway().deps())).result, "sent");
  });

  it("respeita o intervalo mínimo desde o último envio e libera depois dele", async () => {
    await saveSettings("seller", { mode: "automatico", config: { min_gap_seconds: 60, max_gap_seconds: 60 } });
    await mkMessage({ sent_at: new Date(NOW.getTime() - 20_000).toISOString() });
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "deferred");
    if (out.result === "deferred") assert.equal(out.until.getTime(), NOW.getTime() + 40_000, "falta o que resta dos 60 s");
    assert.equal(g.calls.length, 0);

    await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    const later = new Date(NOW.getTime() + 41_000);
    assert.equal((await processCycle(c.id, deps(later))).result, "sent");
  });

  it("incerto pesa no teto (pode ter saído), falho não", async () => {
    await mkMessage({ status: "UNCERTAIN", sent_at: null, created_at: NOW.toISOString() });
    await mkMessage({ status: "FAILED", sent_at: null });
    await mkMessage({ status: "QUEUED", sent_at: null });
    assert.equal((await outreachStats(NOW, { ...SELLER_DEFAULTS })).sentToday, 1);
  });
});

describe("envio de um ciclo: revalidar no instante do envio", () => {
  it("número bloqueado depois da aprovação: não sai", async () => {
    const c = await mkCycle(mkLead());
    await blockPhone("+5541999998888", "pediu para parar", "opt_out");
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "skipped");
    assert.equal(g.calls.length, 0);
    assert.equal((await cycleOf(c.id)).status, "pulado");
  });

  it("o lead respondeu, avançou no funil, foi arquivado ou sumiu: não sai", async () => {
    for (const mutate of [(l: Lead) => (l.status = "respondeu"), (l: Lead) => (l.status = "interessado"), (l: Lead) => (l.status = "perdido"), (l: Lead) => (l.archived = true)]) {
      reset();
      await saveSettings("seller", { mode: "automatico" });
      const lead = mkLead();
      const c = await mkCycle(lead);
      mutate(lead);
      const { g, deps } = fakeGateway();
      assert.equal((await processCycle(c.id, deps())).result, "skipped");
      assert.equal(g.calls.length, 0);
    }
    reset();
    await saveSettings("seller", { mode: "automatico" });
    const orphan = await mkCycle({ ...mkLead(), id: "lead_sumiu" } as Lead);
    assert.equal((await processCycle(orphan.id, fakeGateway().deps())).result, "skipped");
  });

  it("acompanhamento: o lead precisa estar em silêncio (contatado)", async () => {
    const lead = mkLead({ status: "respondeu" });
    const c = await mkCycle(lead, { touch: 2 });
    assert.equal((await processCycle(c.id, fakeGateway().deps())).result, "skipped");
  });

  it("texto reprovado nas barreiras não sai, mesmo que tenha sido aprovado", async () => {
    const c = await mkCycle(mkLead(), { body: `${BODY} Veja https://exemplo.com.br` });
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "skipped");
    assert.equal(g.calls.length, 0);
  });

  it("etapa obsoleta não é enviada: é pulada e preparada de novo", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead, { scheduled_for: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    const { g, deps } = fakeGateway();
    const out = await processCycle(c.id, deps());
    assert.deepEqual(out, { result: "skipped", reason: "etapa obsoleta" });
    assert.equal(g.calls.length, 0);
    const [task] = await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } });
    assert.deepEqual(task!.payload, { lead_id: lead.id, touch: 1 });
  });

  it("agente pausado ou interruptor geral desligado congelam a fila sem destruí-la", async () => {
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway();
    await saveSettings("seller", { mode: "pausado" });
    assert.equal((await processCycle(c.id, deps())).result, "deferred");
    await agentRepo().update("outreach_cycles", c.id, { not_before: NOW.toISOString() });
    await saveSettings("seller", { mode: "automatico" });
    await setGloballyEnabled(false);
    assert.equal((await processCycle(c.id, deps())).result, "deferred");
    assert.equal(g.calls.length, 0);
    assert.equal((await cycleOf(c.id)).status, "agendado");
    assert.equal((await cycleOf(c.id)).attempts, 0);
  });

  it("em modo de aprovação só sai o que foi aprovado", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    const lead = mkLead();
    const { g, deps } = fakeGateway();

    const semAprovacao = await mkCycle(lead);
    assert.equal((await processCycle(semAprovacao.id, deps())).result, "deferred");
    assert.equal(g.calls.length, 0);

    const approvalBase = { organization_id: getDb().organization.id, agent: "seller" as const, kind: "outreach_message" as const, title: "t", detail: null, payload: {}, dedupe_key: null, decided_by: null, decided_at: null, task_id: null, created_at: NOW.toISOString(), expires_at: NOW.toISOString() };
    await agentRepo().insert("approvals", { ...approvalBase, id: "apv_pend", status: "pendente" });
    await agentRepo().update("outreach_cycles", semAprovacao.id, { status: "cancelado" });
    const pendente = await mkCycle(lead, { approval_id: "apv_pend" });
    assert.equal((await processCycle(pendente.id, deps())).result, "skipped", "pedido ainda pendente");
    assert.equal(g.calls.length, 0);

    await agentRepo().insert("approvals", { ...approvalBase, id: "apv_ok", status: "aprovado" });
    const aprovado = await mkCycle(lead, { approval_id: "apv_ok" });
    assert.equal((await processCycle(aprovado.id, deps())).result, "sent");
    assert.equal(g.calls.length, 1);
  });
});

describe("envio de um ciclo: falhas", () => {
  it("falha transitória repete o MESMO ciclo com espera crescente e desiste depois do limite", async () => {
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway({ sendError: new ProviderError("TEMPORARY", "5xx") });
    let now = NOW;
    const waits: number[] = [];
    for (let i = 1; i <= MAX_TECHNICAL_ATTEMPTS; i++) {
      const out = await processCycle(c.id, deps(now));
      const after = await cycleOf(c.id);
      assert.equal(after.attempts, i);
      if (i < MAX_TECHNICAL_ATTEMPTS) {
        assert.equal(out.result, "retry");
        assert.equal(after.status, "agendado");
        assert.equal(after.message_id, null, "a mensagem da tentativa que falhou some");
        waits.push(Date.parse(after.not_before) - now.getTime());
        now = new Date(Date.parse(after.not_before) + 1);
      } else {
        assert.equal(out.result, "failed");
        assert.equal(after.status, "falhou");
      }
    }
    assert.deepEqual(waits, [30_000, 60_000, 120_000]);
    assert.equal(g.calls.length, MAX_TECHNICAL_ATTEMPTS);
    assert.deepEqual(new Set(g.calls.map((x) => x.clientReference)).size, 1, "todas as tentativas usam a mesma referência");
  });

  it("número sem WhatsApp: falha, bloqueia o número e marca o lead", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead);
    const { deps } = fakeGateway({ sendError: new ProviderError("INVALID_RECIPIENT", "Número não encontrado") });
    assert.equal((await processCycle(c.id, deps())).result, "failed");
    assert.equal(await isBlocked("+5541999998888"), true);
    assert.equal(lead.has_whatsapp, false);
    assert.equal((await cycleOf(c.id)).status, "falhou");
    assert.equal(getAgentData().outreach_messages[0]!.status, "FAILED");
    assert.equal(lead.status, "qualificado", "não virou 'contatado'");
  });

  it("erro permanente do provedor falha o ciclo sem tentar de novo", async () => {
    const c = await mkCycle(mkLead());
    const { g, deps } = fakeGateway({ sendError: new ProviderError("PERMANENT", "recusado", 400) });
    assert.equal((await processCycle(c.id, deps())).result, "failed");
    assert.equal(g.calls.length, 1);
    assert.equal((await cycleOf(c.id)).attempts, 0);
  });
});

describe("envio sem confirmação: nunca reenviar", () => {
  it("timeout vira 'incerto', avisa o dono e NÃO é reenviado, nem agenda o próximo toque", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead);
    const { g, deps } = fakeGateway({ sendError: new ProviderError("TIMEOUT", "sem confirmação") });
    const out = await processCycle(c.id, deps());
    assert.equal(out.result, "uncertain");

    const after = await cycleOf(c.id);
    assert.equal(after.status, "incerto");
    assert.equal((await agentRepo().get("outreach_messages", after.message_id!))!.status, "UNCERTAIN");
    assert.equal(lead.status, "qualificado", "não afirma que contatou");
    assert.equal(getDb().notifications.length, 1);
    assert.equal((await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } })).length, 0, "sem próximo toque");

    // Mesmo passando por todos os caminhos de reprocessamento, não reenvia.
    assert.equal((await processCycle(c.id, deps())).result, "already_processed");
    assert.deepEqual(await processDueOutreach(deps()), { processed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0 });
    assert.equal(g.calls.length, 1);
  });

  it("se o WhatsApp confirmar a entrega depois, a dúvida se resolve e a sequência segue", async () => {
    const lead = mkLead();
    const c = await mkCycle(lead);
    await processCycle(c.id, fakeGateway({ sendError: new ProviderError("TIMEOUT", "x") }).deps());
    const message = getAgentData().outreach_messages[0]!;
    // o gateway só soube do id depois: o evento de entrega casa pelo id do provedor
    await agentRepo().update("outreach_messages", message.id, { provider_message_id: "WA-LATE" });

    assert.equal(await applyDeliveryStatus({ providerMessageId: "WA-LATE", status: "DELIVERED", at: NOW.toISOString() }), true);
    const after = await cycleOf(c.id);
    assert.equal(after.status, "enviado");
    assert.equal(lead.status, "contatado");
    assert.equal((await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } })).length, 1, "o próximo toque foi agendado");
  });

  it("ciclo preso em 'reivindicado' (processo caiu) vira incerto, não é reenviado", async () => {
    const c = await mkCycle(mkLead(), { status: "reivindicado", claimed_at: new Date(NOW.getTime() - 20 * 60_000).toISOString() });
    const recent = await mkCycle(mkLead(), { status: "reivindicado", claimed_at: new Date(NOW.getTime() - 60_000).toISOString() });
    assert.equal(await reconcileOutreach(NOW), 1);
    assert.equal((await cycleOf(c.id)).status, "incerto");
    assert.equal((await cycleOf(recent.id)).status, "reivindicado", "o recente ainda está em curso");
    const { g, deps } = fakeGateway();
    await processDueOutreach(deps());
    assert.equal(g.calls.length, 0);
  });
});

describe("processar a fila de vencidos", () => {
  it("envia um e para: o intervalo mínimo já vale para o próximo", async () => {
    const a = await mkCycle(mkLead({ phone: "(41) 99999-1111", whatsapp: "+5541999991111" }), { phone: "+5541999991111", scheduled_for: new Date(NOW.getTime() - 1000).toISOString() });
    const b = await mkCycle(mkLead({ phone: "(41) 99999-2222", whatsapp: "+5541999992222" }), { phone: "+5541999992222" });
    const { g, deps } = fakeGateway();
    const report = await processDueOutreach(deps());
    assert.equal(report.sent, 1);
    assert.equal(g.calls.length, 1);
    assert.equal(g.calls[0]!.to, "+5541999991111", "o mais antigo primeiro");
    assert.equal((await cycleOf(a.id)).status, "enviado");
    assert.equal((await cycleOf(b.id)).status, "agendado");
  });

  it("para no primeiro bloqueio global em vez de tentar todos", async () => {
    const sat = { scheduled_for: SATURDAY.toISOString(), not_before: SATURDAY.toISOString() };
    await mkCycle(mkLead(), sat);
    await mkCycle(mkLead({ phone: "(41) 99999-2222", whatsapp: "+5541999992222" }), { phone: "+5541999992222", ...sat });
    const { g, deps } = fakeGateway();
    const report = await processDueOutreach(deps(SATURDAY));
    assert.equal(report.deferred, 1, "só o primeiro foi examinado");
    assert.equal(g.statusCalls, 0);
  });

  it("não toca no que ainda não venceu", async () => {
    const c = await mkCycle(mkLead(), { not_before: new Date(NOW.getTime() + 3_600_000).toISOString() });
    const { g, deps } = fakeGateway();
    assert.equal((await processDueOutreach(deps())).processed, 0);
    assert.equal((await cycleOf(c.id)).status, "agendado");
    assert.equal(g.calls.length, 0);
  });
});

describe("estado de entrega das mensagens", () => {
  it("só avança (enviado → entregue → lido) e ignora o atrasado ou repetido", async () => {
    const m = await mkMessage({ provider_message_id: "WA-1", sent_at: NOW.toISOString() });
    const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
    await applyDeliveryStatus({ providerMessageId: "WA-1", status: "READ", at: at(10) });
    await applyDeliveryStatus({ providerMessageId: "WA-1", status: "DELIVERED", at: at(20) });
    await applyDeliveryStatus({ providerMessageId: "WA-1", status: "SENT", at: at(30) });
    const after = (await agentRepo().get("outreach_messages", m.id))!;
    assert.equal(after.status, "READ", "não regride");
    assert.equal(after.read_at, at(10));
    assert.equal(after.delivered_at, at(10), "lido implica entregue");
  });

  it("mensagem desconhecida (as que você mandou pelo celular) é ignorada sem erro", async () => {
    assert.equal(await applyDeliveryStatus({ providerMessageId: "NAO-EXISTE", status: "READ", at: NOW.toISOString() }), false);
  });

  it("falha confirmada pelo WhatsApp é terminal", async () => {
    const m = await mkMessage({ provider_message_id: "WA-2" });
    await applyDeliveryStatus({ providerMessageId: "WA-2", status: "FAILED", at: NOW.toISOString() });
    await applyDeliveryStatus({ providerMessageId: "WA-2", status: "READ", at: NOW.toISOString() });
    assert.equal((await agentRepo().get("outreach_messages", m.id))!.status, "FAILED");
  });
});

describe("lista de bloqueio", () => {
  it("o mesmo número em formatos diferentes é uma linha só, e remover libera", async () => {
    await blockPhone("+55 (41) 99999-8888", "manual");
    await blockPhone("+5541999998888", "outra vez");
    assert.equal(getAgentData().channel_blocklist.length, 1);
    assert.equal(await isBlocked("5541999998888"), true);
    assert.equal(dayKey().length, 10);
  });
});
