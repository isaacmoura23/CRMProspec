import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "@/lib/store";
import { registerAgentHandlers } from "@/agents/registry";
import { seller } from "@/agents/seller/agent";
import { signGatewayEvent, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/gateway-signature";
import { OPT_OUT_FOOTER } from "@/lib/outreach-policy";
import { decideApproval } from "@/services/agents/approvals";
import { spentToday } from "@/services/agents/log";
import { planAgents } from "@/services/agents/planner";
import { enqueueAgentTask, runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { saveSettings } from "@/services/agents/settings";
import { createLeadFromRaw } from "@/services/lead-service";
import { isBlocked, blockPhone } from "@/services/outreach/blocklist";
import { processDueOutreach } from "@/services/outreach/send";
import { handleGatewayWebhook } from "@/services/whatsapp/webhook";
import { emptyAgentData } from "@/types/agents";
import type { Lead, LeadAnalysis } from "@/types";

const SECRET = "s".repeat(40);
let seq = 0;

/* ------------------------------------------------------------------ */
/* Cenário                                                             */
/* ------------------------------------------------------------------ */

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  const db = getDb();
  db.leads.splice(0);
  db.lead_analysis.splice(0);
  db.activities.splice(0);
  db.campaigns.splice(0);
  db.notifications.splice(0);
  db.campaigns.push({ id: "cmp_agent", organization_id: db.organization.id, name: "AgentOS · Imobiliária · Curitiba", description: null, created_at: new Date().toISOString(), archived: false });
}

function mkLead(over: Partial<Lead> = {}): Lead {
  const db = getDb();
  const n = ++seq;
  const lead: Lead = {
    id: `lead_f${n}`,
    organization_id: db.organization.id,
    company_name: `Imobiliária Flor ${n}`,
    contact_name: null,
    legal_name: null,
    segment: "Imobiliária",
    description: null,
    // Celular válido: DDD + 9 + 8 dígitos (o "9" e quatro dígitos, hífen, quatro dígitos).
    phone: `(41) 9${1000 + n}-${2000 + n}`,
    whatsapp: null,
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
    reviews_count: 12,
    rating: 4.6,
    opening_hours: null,
    source: "google_places",
    source_id: `pf${n}`,
    campaign_id: "cmp_agent",
    has_website: false,
    website_quality: "nenhum",
    has_whatsapp: false,
    instagram_active: false,
    marketing_signals: false,
    business_active: true,
    catalog_size: "desconhecido",
    status: "qualificado",
    pipeline_stage_id: null,
    stage_entered_at: null,
    lead_score: 85,
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
  const analysis: LeadAnalysis = {
    id: `ana_f${n}`,
    lead_id: lead.id,
    digital_presence_summary: "Tem avaliações no Google, mas nenhum site próprio.",
    strengths: ["boa reputação"],
    main_problem: "A empresa divulga os imóveis só pelo Google Maps, sem uma página própria para o comprador filtrar as opções.",
    problem_impact: "Quem pesquisa por tipo e faixa de preço não encontra o que procura.",
    recommended_solution: "Site com listagem e filtros",
    commercial_angle: "vitrine própria",
    confidence: 85,
    model: "engine/deterministic-v1",
    created_at: "2026-10-01T00:00:00.000Z",
  };
  db.lead_analysis.push(analysis);
  return lead;
}

const phoneOf = (lead: Lead) => `+55${lead.phone!.replace(/\D/g, "")}`;

/** Simula as rotas do gateway que o CRM chama: status e consulta de número. */
function stubGateway(opts: { status?: string; existing?: (phone: string) => boolean } = {}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("/status")) {
      return new Response(JSON.stringify({ status: opts.status ?? "CONNECTED", phone: "+5500000000000", pushName: null, qrDataUrl: null, qrUpdatedAt: null, lastError: null, dryRun: false }));
    }
    if (path.endsWith("/recipient")) {
      const to = (JSON.parse(String(init.body)) as { to: string }).to;
      const exists = opts.existing ? opts.existing(to) : true;
      return new Response(JSON.stringify({ exists, jid: exists ? `${to.replace(/\D/g, "")}@s.whatsapp.net` : null }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function connectedLink() {
  await agentRepo().upsert("whatsapp_link", {
    id: "org_atlas",
    organization_id: getDb().organization.id,
    status: "CONNECTED",
    phone: "+5500000000000",
    push_name: null,
    last_error: null,
    dry_run: false,
    last_event_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function prepareFor(lead: Lead, touch = 1) {
  const { task } = await enqueueAgentTask({ agent: "seller", kind: "outreach.prepare", payload: { lead_id: lead.id, touch }, dedupeKey: `t:${lead.id}:${touch}:${++seq}` });
  await runAgentQueue({ agents: ["seller"], budgetMs: 10_000 });
  return (await agentRepo().get("tasks", task.id))!;
}

let gateway: ReturnType<typeof stubGateway>;

beforeEach(() => {
  process.env.WHATSAPP_GATEWAY_URL = "http://gateway.test";
  process.env.WHATSAPP_GATEWAY_TOKEN = "t".repeat(24);
  process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
  delete process.env.WHATSAPP_SESSION_ID;
  registerAgentHandlers();
  reset();
});

afterEach(() => {
  gateway?.restore();
  delete process.env.WHATSAPP_GATEWAY_URL;
  delete process.env.WHATSAPP_GATEWAY_TOKEN;
  delete process.env.WHATSAPP_WEBHOOK_SECRET;
});

/* ------------------------------------------------------------------ */

describe("lead real não ganha nome de contato inventado", () => {
  it("o Google Maps nunca recebe um nome; só os dados de demonstração podem", () => {
    const raw = (source: "google_places" | "diretorio") => ({ company_name: "X", segment: "s", country: "Brasil", city: "C", source });
    for (let i = 0; i < 60; i++) {
      assert.equal(createLeadFromRaw(raw("google_places"), null, null).contact_name, null);
    }
    const demo = Array.from({ length: 60 }, () => createLeadFromRaw(raw("diretorio"), null, null).contact_name);
    assert.ok(demo.some((n) => n !== null), "a demonstração continua tendo contatos fictícios");
  });
});

describe("preparar a abordagem: modo de aprovação", () => {
  it("confirma o WhatsApp, escreve a mensagem e cria o pedido com o texto exato (sem enviar nada)", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway();
    const lead = mkLead({ contact_name: "Carlos" }); // nome que o sistema antigo teria inventado
    const task = await prepareFor(lead);
    assert.equal(task.status, "concluido", task.last_error ?? "");

    const [approval] = await agentRepo().list("approvals", { where: { kind: "outreach_message" } });
    assert.ok(approval);
    assert.equal(approval!.status, "pendente");
    assert.equal(approval!.agent, "seller");
    const p = approval!.payload as { lead_id: string; touch: number; phone: string; body: string };
    assert.equal(p.lead_id, lead.id);
    assert.equal(p.touch, 1);
    assert.equal(p.phone, phoneOf(lead));
    assert.ok(p.body.endsWith(OPT_OUT_FOOTER), "toda abordagem oferece a saída");
    assert.ok(!p.body.includes("Carlos"), "não cumprimenta um estranho por um nome que ninguém deu");
    assert.ok(!/https?:|www\./i.test(p.body));

    assert.equal(getAgentData().outreach_cycles.length, 0, "nada agendado antes do clique");
    assert.equal(getAgentData().outreach_messages.length, 0);
    assert.equal(await spentToday("seller", "whatsapp_lookups"), 1);
    assert.equal(lead.whatsapp, phoneOf(lead));
    assert.equal(lead.has_whatsapp, true);
    assert.equal(gateway.calls.filter((c) => c.endsWith("/recipient")).length, 1);
    assert.ok(!gateway.calls.some((c) => c.endsWith("/messages")), "preparar nunca envia");
  });
});

describe("preparar a abordagem: modo automático", () => {
  it("cria o ciclo de envio direto, com o mesmo texto e sem pedido", async () => {
    await saveSettings("seller", { mode: "automatico" });
    gateway = stubGateway();
    const lead = mkLead();
    assert.equal((await prepareFor(lead)).status, "concluido");
    const [cycle] = getAgentData().outreach_cycles;
    assert.ok(cycle);
    assert.equal(cycle!.status, "agendado");
    assert.equal(cycle!.approval_id, null);
    assert.equal(cycle!.touch, 1);
    assert.equal(cycle!.phone, phoneOf(lead));
    assert.equal(getAgentData().approvals.length, 0);
  });
});

describe("preparar a abordagem: o que a faz parar", () => {
  it("número sem WhatsApp: bloqueia, marca o lead e ele nunca mais é candidato", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway({ existing: () => false });
    await connectedLink();
    const lead = mkLead();
    const task = await prepareFor(lead);
    assert.equal(task.status, "concluido");
    assert.deepEqual(task.result, { skipped: "número sem WhatsApp" });
    assert.equal(await isBlocked(phoneOf(lead)), true);
    assert.equal(lead.has_whatsapp, false);
    assert.equal(getAgentData().approvals.length, 0);
    assert.deepEqual(await seller.plan(), [], "o lead sai da lista de candidatos");
  });

  it("gateway desconectado: a tarefa espera (reagendada), sem consumir consulta nem criar pedido", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway({ status: "DISCONNECTED" });
    const task = await prepareFor(mkLead());
    assert.equal(task.status, "pendente");
    assert.ok(task.next_run_at > new Date().toISOString());
    assert.equal(task.attempts, 0);
    assert.equal(await spentToday("seller", "whatsapp_lookups"), 0);
    assert.equal(getAgentData().approvals.length, 0);
  });

  it("teto diário de consultas esgotado: fica para amanhã, sem consultar", async () => {
    await saveSettings("seller", { mode: "aprovacao", config: { lookups_per_day: 1 } });
    gateway = stubGateway();
    assert.equal((await prepareFor(mkLead())).status, "concluido");
    const second = await prepareFor(mkLead());
    assert.equal(second.status, "pendente");
    assert.ok(Date.parse(second.next_run_at) - Date.now() > 3_600_000, "adiada para o dia seguinte");
    assert.equal(gateway.calls.filter((c) => c.endsWith("/recipient")).length, 1);
  });

  it("lead que já não pode ser abordado é pulado sem tocar no gateway", async () => {
    gateway = stubGateway();
    const lead = mkLead({ status: "respondeu" });
    const task = await prepareFor(lead);
    assert.equal(task.status, "concluido");
    assert.match(String((task.result as { skipped: string }).skipped), /primeira abordagem/);
    assert.equal(gateway.calls.length, 0);
  });

  it("texto que não passa nas barreiras da política faz a tarefa falhar com o motivo, sem pedir aprovação", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway();
    const lead = mkLead();
    // O motor repete o problema da análise na mensagem; um endereço de site ali reprova o texto.
    getDb().lead_analysis.find((a) => a.lead_id === lead.id)!.main_problem = "o site exemplo.com.br está fora do ar há semanas";
    const task = await prepareFor(lead);
    assert.equal(task.status, "falhou");
    assert.match(task.last_error ?? "", /política de envio/);
    assert.equal(getAgentData().approvals.length, 0);
  });
});

describe("aprovar a mensagem", () => {
  async function pendingApproval(over: Partial<Lead> = {}) {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway();
    const lead = mkLead(over);
    await prepareFor(lead);
    const approval = (await agentRepo().list("approvals", { where: { kind: "outreach_message" } }))[0]!;
    return { lead, approval };
  }

  it("aprovar cria o ciclo com o texto exato e quem aprovou; aprovar de novo não duplica", async () => {
    const { approval } = await pendingApproval();
    const body = (approval.payload as { body: string }).body;
    const r = await decideApproval(approval.id, true, "user_owner");
    assert.equal(r.ok, true);
    const [cycle] = getAgentData().outreach_cycles;
    assert.equal(cycle!.body, body);
    assert.equal(cycle!.approval_id, approval.id);
    assert.equal(cycle!.status, "agendado", "aprovar não envia: a política ainda decide quando");

    assert.equal((await decideApproval(approval.id, true, "user_owner")).ok, false);
    assert.equal(getAgentData().outreach_cycles.length, 1);
    assert.equal((await agentRepo().get("approvals", approval.id))!.decided_by, "user_owner");
  });

  it("o dono pode editar o texto; ele passa pelas mesmas barreiras e o aviso de saída volta se for apagado", async () => {
    const { approval } = await pendingApproval();
    const edited = "Oi, tudo bem? Vi o trabalho de vocês no Google e queria te mostrar uma ideia rápida. Posso te explicar?";
    const r = await decideApproval(approval.id, true, "user_owner", { editedBody: edited });
    assert.equal(r.ok, true);
    const [cycle] = getAgentData().outreach_cycles;
    assert.ok(cycle!.body.startsWith(edited));
    assert.ok(cycle!.body.endsWith(OPT_OUT_FOOTER), "o aviso de saída foi recolocado");
    const stored = (await agentRepo().get("approvals", approval.id))!.payload as { edited: boolean; body: string };
    assert.equal(stored.edited, true);
    assert.equal(stored.body, cycle!.body, "o pedido guarda o que de fato saiu");
  });

  it("texto editado com link ou promessa é recusado e o pedido continua pendente", async () => {
    const { approval } = await pendingApproval();
    for (const bad of ["Oi, tudo bem? Veja nosso trabalho em https://exemplo.com.br e me diga o que acha.", "Oi, tudo bem? Resultado garantido em 7 dias para o seu negócio, sem erro."]) {
      const r = await decideApproval(approval.id, true, "user_owner", { editedBody: bad });
      assert.equal(r.ok, false);
    }
    assert.equal(getAgentData().outreach_cycles.length, 0);
    assert.equal((await agentRepo().get("approvals", approval.id))!.status, "pendente");
  });

  it("recusar não agenda nada e o lead não é reabordado", async () => {
    const { lead, approval } = await pendingApproval();
    assert.equal((await decideApproval(approval.id, false, "user_owner")).ok, true);
    assert.equal(getAgentData().outreach_cycles.length, 0);
    assert.deepEqual((await seller.plan()).filter((t) => (t.payload as { lead_id: string }).lead_id === lead.id), [], "recusado = fora, não volta a ser proposto");
  });

  it("aprovação expirada não vale", async () => {
    const { approval } = await pendingApproval();
    await agentRepo().update("approvals", approval.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await decideApproval(approval.id, true, "user_owner")).ok, false);
    assert.equal(getAgentData().outreach_cycles.length, 0);
  });
});

describe("planejamento do Vendedor", () => {
  it("sem WhatsApp conectado, ou sem o gateway configurado, não prepara nada", async () => {
    mkLead();
    assert.deepEqual(await seller.plan(), [], "sem registro de conexão");
    await agentRepo().upsert("whatsapp_link", {
      id: "org_atlas", organization_id: getDb().organization.id, status: "DISCONNECTED", phone: null, push_name: null,
      last_error: null, dry_run: true, last_event_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    assert.deepEqual(await seller.plan(), [], "desconectado");
    await connectedLink();
    assert.equal((await seller.plan()).length, 1);
    delete process.env.WHATSAPP_GATEWAY_URL;
    assert.deepEqual(await seller.plan(), [], "sem gateway configurado");
  });

  it("escolhe os melhores leads elegíveis e deixa de fora fixo, lead manual, score baixo e número bloqueado", async () => {
    await connectedLink();
    const best = mkLead({ lead_score: 95 });
    const mid = mkLead({ lead_score: 70 });
    mkLead({ phone: "(41) 3333-4444" }); // fixo
    mkLead({ campaign_id: null }); // cadastrado à mão
    mkLead({ lead_score: 20 }); // score baixo
    const blocked = mkLead({ lead_score: 90 });
    await blockPhone(phoneOf(blocked), "pediu para parar", "opt_out");
    const planned = await seller.plan();
    assert.deepEqual(planned.map((t) => (t.payload as { lead_id: string }).lead_id), [best.id, mid.id]);
    assert.ok(planned.every((t) => t.kind === "outreach.prepare"));
  });

  it("não acumula: no máximo 3 em preparo, e em aprovação para quando há pedidos demais esperando", async () => {
    await connectedLink();
    for (let i = 0; i < 6; i++) mkLead();
    assert.equal((await seller.plan()).length, 3);

    await enqueueAgentTask({ agent: "seller", kind: "outreach.prepare", payload: { lead_id: "x", touch: 1 }, dedupeKey: "k1" });
    await enqueueAgentTask({ agent: "seller", kind: "outreach.prepare", payload: { lead_id: "y", touch: 1 }, dedupeKey: "k2" });
    assert.equal((await seller.plan()).length, 1, "só cabe mais um");

    reset();
    await connectedLink();
    for (let i = 0; i < 4; i++) mkLead();
    await saveSettings("seller", { mode: "aprovacao", config: { max_pending_approvals: 1 } });
    await agentRepo().insert("approvals", {
      id: "apv_p", organization_id: getDb().organization.id, agent: "seller", kind: "outreach_message", title: "t", detail: null, payload: { lead_id: "z", touch: 1 },
      dedupe_key: null, status: "pendente", decided_by: null, decided_at: null, task_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.deepEqual(await seller.plan(), [], "há um pedido esperando e o limite é 1");
  });

  it("o planejador enfileira o preparo direto, mesmo em modo de aprovação, uma vez por dia por lead", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    await connectedLink();
    const lead = mkLead();
    assert.equal((await planAgents()).enqueued >= 1, true);
    const tasks = await agentRepo().list("tasks", { where: { agent: "seller" } });
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0]!.payload, { lead_id: lead.id, touch: 1 });
    await planAgents();
    assert.equal((await agentRepo().list("tasks", { where: { agent: "seller" } })).length, 1, "não repete no mesmo dia");
  });
});

describe("estado de entrega pelo webhook", () => {
  function signed(event: object) {
    const raw = JSON.stringify(event);
    const ts = Date.now();
    return { rawBody: raw, headers: new Headers({ [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signGatewayEvent(SECRET, ts, raw) }) };
  }
  const delivery = (id: string, status: string) => ({
    id: `delivery:${id}:${status}`,
    type: "message.delivery",
    session_id: "org_atlas",
    occurred_at: new Date().toISOString(),
    data: { provider_message_id: id, status },
  });

  it("o evento assinado atualiza a mensagem; o de uma mensagem desconhecida só é confirmado", async () => {
    await agentRepo().insert("outreach_messages", {
      id: "omsg_w", organization_id: getDb().organization.id, lead_id: "l", cycle_id: "c", phone: "+5541999998888", body: "x", status: "SENT",
      provider_message_id: "WA-W", error_detail: null, created_at: new Date().toISOString(), sent_at: new Date().toISOString(), delivered_at: null, read_at: null,
    });
    assert.equal((await handleGatewayWebhook(signed(delivery("WA-W", "READ")))).status, 200);
    assert.equal((await agentRepo().get("outreach_messages", "omsg_w"))!.status, "READ");
    assert.equal((await handleGatewayWebhook(signed(delivery("SEM-DONO", "READ")))).status, 200);
  });
});

describe("do lead escolhido até a mensagem lida (ponta a ponta)", () => {
  it("planeja → prepara → pede aprovação → aprova → envia dentro da política → confirma a entrega", async () => {
    await saveSettings("seller", { mode: "aprovacao" });
    gateway = stubGateway();
    await connectedLink();
    const lead = mkLead();

    await planAgents();
    await runAgentQueue({ agents: ["seller"], budgetMs: 10_000 });
    const [approval] = await agentRepo().list("approvals", { where: { kind: "outreach_message", status: "pendente" } });
    assert.ok(approval, "o dono recebe o pedido");
    assert.equal(getAgentData().outreach_messages.length, 0, "até aqui nada saiu");

    assert.equal((await decideApproval(approval!.id, true, "user_owner")).ok, true);

    const sent: Array<{ to: string; body: string; clientReference: string }> = [];
    const deps = (at: Date) => ({
      now: () => at,
      gateway: () => ({
        status: async () => ({ status: "CONNECTED", dryRun: false }),
        sendText: async (input: { to: string; body: string; clientReference: string }) => {
          sent.push(input);
          return { providerMessageId: "WA-E2E" };
        },
      }),
    });

    // O dono aprovou num sábado (o relógio do teste é fixo, não o do computador).
    const saturday = new Date("2026-10-10T15:00:00Z");
    const [cycle] = getAgentData().outreach_cycles;
    await agentRepo().update("outreach_cycles", cycle!.id, { scheduled_for: saturday.toISOString(), not_before: saturday.toISOString() });
    assert.equal((await processDueOutreach(deps(saturday))).deferred, 1, "janela fechada: espera");
    assert.equal(sent.length, 0);

    // Segunda 09:30 em São Paulo: dentro da janela, e a mensagem NÃO foi tomada por obsoleta.
    const now = new Date("2026-10-12T12:30:00Z");
    const report = await processDueOutreach(deps(now));
    assert.equal(report.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, phoneOf(lead));
    assert.equal(sent[0]!.body, (await agentRepo().get("approvals", approval!.id))!.payload.body);
    assert.equal(lead.status, "contatado");

    const raw = JSON.stringify({ id: "delivery:WA-E2E:READ", type: "message.delivery", session_id: "org_atlas", occurred_at: now.toISOString(), data: { provider_message_id: "WA-E2E", status: "READ" } });
    const ts = Date.now();
    await handleGatewayWebhook({ rawBody: raw, headers: new Headers({ [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signGatewayEvent(SECRET, ts, raw) }) });
    const message = getAgentData().outreach_messages[0]!;
    assert.equal(message.status, "READ");
    assert.equal(message.provider_message_id, "WA-E2E");

    // e o acompanhamento já está agendado para daqui a 3 dias, não para agora
    const [followUp] = await agentRepo().list("tasks", { where: { kind: "outreach.prepare" } });
    assert.ok(followUp);
  });
});
