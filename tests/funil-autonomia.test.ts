import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "@/lib/store";
import { AGENTS, registerAgentHandlers } from "@/agents/registry";
import { signGatewayEvent, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/lib/gateway-signature";
import { planAgents } from "@/services/agents/planner";
import { runAgentQueue } from "@/services/agents/queue";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { saveSettings, setGloballyEnabled } from "@/services/agents/settings";
import { processDueOwnerNotices } from "@/services/conversation/notices";
import { getConversationState } from "@/services/conversation/state";
import { createLeadFromRaw } from "@/services/lead-service";
import { isBlocked } from "@/services/outreach/blocklist";
import { processDueOutreach } from "@/services/outreach/send";
import { buildDossierForLead } from "@/services/presence/build";
import { publicCreativeFile } from "@/services/creatives/engine";
import { siteBuildTestHooks, readPreview } from "@/services/sites/build";
import { handleGatewayWebhook } from "@/services/whatsapp/webhook";
import { emptyAgentData } from "@/types/agents";
import type { Lead, LeadAnalysis } from "@/types";
import { installCreativeFakes } from "./creative-fakes";

/**
 * O funil inteiro em modo AUTOMÁTICO, com o WhatsApp simulado (nada real é enviado):
 *   Agente 2 (prospecta) → 3 (dossiê) → 4 (aborda, conversa, marca reunião) → 5 (prévia do site),
 * e os Agentes 6 e 7 só propondo. É a prova de que a autonomia máxima é de fato autônoma — sem um clique
 * de aprovação no caminho — e de que as travas (o que não é permissão) continuam valendo.
 *
 * Duas decisões de teste, ditas aqui: (1) a fonte de demonstração usada pelo Agente 2 gera leads de
 * demonstração, que o envio e o site recusam de propósito; por isso o resto do funil roda com um lead
 * criado pelo mesmo `createLeadFromRaw`, com fonte "google_places". (2) Telefones e domínios são fictícios.
 */

const SECRET = "s".repeat(40);
const OWNER = "+5511988776655";
let seq = 0;

const ALWAYS_OPEN = { send_days: [1, 2, 3, 4, 5, 6, 7], start_hour: 0, end_hour: 24, min_gap_seconds: 10, max_gap_seconds: 10, meeting_days: [1, 2, 3, 4, 5, 6, 7], meeting_start_hour: 9, meeting_end_hour: 18, owner_phone: OWNER };
const AGENT_IDS = AGENTS.map((a) => a.id);

/* ------------------------------ cenário ------------------------------ */

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
  const db = getDb();
  for (const k of ["leads", "lead_analysis", "activities", "campaigns", "notifications", "conversations", "messages", "tasks"] as const) (db[k] as unknown[]).splice(0);
  db.campaigns.push({ id: "cmp_agent", organization_id: db.organization.id, name: "AgentOS · Clínica · Curitiba", description: null, created_at: new Date().toISOString(), archived: false });
  Object.assign(db.company_profile, {
    company_name: "AtlasCode",
    what_we_sell: "Sites, redes sociais e anúncios para pequenos negócios.",
    main_services: ["Site profissional", "Gestão de redes sociais"],
    differentiators: ["Atendimento direto com quem faz"],
    problems_we_solve: ["Negócio sem presença digital"],
    never_say: [],
  });
}

function mkLead(over: Partial<Lead> = {}): Lead {
  const db = getDb();
  const n = ++seq;
  // Dados fictícios que o Agente 2 gravaria para uma empresa real do Google Maps, sem site.
  const lead = createLeadFromRaw(
    { company_name: `Clínica Aurora ${n}`, segment: "Clínica", phone: `(41) 9${5000 + n}-${6000 + n}`, city: "Curitiba", state: "PR", country: "Brasil", address: `Rua das Flores, ${n}`, rating: 4.6, reviews_count: 40, source: "google_places", source_id: `fn${n}`, google_maps_url: `https://maps.google.com/?q=aurora${n}`, website: null } as never,
    "cmp_agent",
    null
  );
  Object.assign(lead, { status: "qualificado", lead_score: 90, has_whatsapp: false, ...over });
  const analysis: LeadAnalysis = {
    id: `ana_fn${n}`,
    lead_id: lead.id,
    digital_presence_summary: "Tem avaliações no Google, mas nenhum site próprio.",
    strengths: ["boa reputação"],
    main_problem: "A empresa divulga os serviços só pelo Google Maps, sem uma página própria para o cliente conhecer o trabalho.",
    problem_impact: "Quem pesquisa pelo serviço não encontra o que procura.",
    recommended_solution: "Site com serviços e contato",
    commercial_angle: "vitrine própria",
    confidence: 85,
    model: "engine/deterministic-v1",
    created_at: "2026-10-01T00:00:00.000Z",
  };
  db.lead_analysis.push(analysis);
  return lead;
}

const phoneOf = (lead: Lead) => `+55${lead.phone!.replace(/\D/g, "")}`;

function signed(event: object) {
  const raw = JSON.stringify(event);
  const ts = Date.now();
  return { rawBody: raw, headers: new Headers({ [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signGatewayEvent(SECRET, ts, raw) }) };
}

async function leadSays(peer: string, text: string, over: Record<string, unknown> = {}) {
  const id = `IN-${++seq}-${Math.random().toString(16).slice(2, 8)}`;
  const res = await handleGatewayWebhook(
    signed({ id: `received:${id}`, type: "message.received", session_id: "org_atlas", occurred_at: new Date().toISOString(), data: { provider_message_id: id, peer, text, media_type: null, profile_name: "Contato", ...over } })
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

/** Gateway simulado: guarda tudo o que "seria enviado" e a quem. */
function outbox() {
  const sent: Array<{ to: string; body: string; clientReference: string }> = [];
  const deps = {
    gateway: () => ({
      status: async () => ({ status: "CONNECTED", dryRun: false }),
      sendText: async (input: { to: string; body: string; clientReference: string }) => {
        sent.push(input);
        return { providerMessageId: `WA-SIM-${sent.length}` };
      },
    }),
  };
  return { sent, deps };
}

interface Calls {
  graphWrites: string[];
  graphAll: string[];
  llm: string[];
  gateway: string[];
}

/** fetch simulado: o gateway (status e consulta de número) responde; Graph e provedores de IA só registram. */
function stubFetch(): { calls: Calls; restore: () => void } {
  const calls: Calls = { graphWrites: [], graphAll: [], llm: [], gateway: [] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "gateway.test") {
      calls.gateway.push(u.pathname);
      if (u.pathname.endsWith("/status")) return new Response(JSON.stringify({ status: "CONNECTED", phone: "+5500000000000", pushName: null, qrDataUrl: null, qrUpdatedAt: null, lastError: null, dryRun: false }));
      if (u.pathname.endsWith("/recipient")) {
        const to = (JSON.parse(String(init?.body)) as { to: string }).to;
        return new Response(JSON.stringify({ exists: true, jid: `${to.replace(/\D/g, "")}@s.whatsapp.net` }));
      }
      return new Response("{}", { status: 404 });
    }
    if (u.hostname === "graph.facebook.com") {
      calls.graphAll.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if ((init?.method ?? "GET") !== "GET") calls.graphWrites.push(`${init?.method} ${u.pathname}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (/anthropic|openai/.test(u.hostname)) {
      calls.llm.push(u.hostname);
      return new Response("{}", { status: 500 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Passa uma hora: o intervalo mínimo entre envios ao mesmo número já terminou (o relógio do teste é o do computador). */
async function ageOutbox() {
  const before = new Date(Date.now() - 3_600_000).toISOString();
  for (const m of await agentRepo().list("outreach_messages")) await agentRepo().update("outreach_messages", m.id, { created_at: before, sent_at: before, delivered_at: before });
  for (const c of await agentRepo().list("outreach_cycles")) if (c.sent_at) await agentRepo().update("outreach_cycles", c.id, { sent_at: before });
}

async function connectedLink() {
  await agentRepo().upsert("whatsapp_link", { id: "org_atlas", organization_id: getDb().organization.id, status: "CONNECTED", phone: "+5500000000000", push_name: null, last_error: null, dry_run: false, last_event_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

/** Navegador simulado da verificação do site: tudo certo. */
const OK_MEASURE = JSON.stringify({ w: 500, sw: 500, overflow: false, badAnchors: [], errors: [], h1: 1, lowContrast: [] });
const siteBrowser = {
  browser: "fake-chrome",
  run: (async () => ({ stdout: `<html><head><title>ATLAS_VERIFY:${OK_MEASURE.replace(/"/g, "&quot;")}</title></head></html>`, stderr: "", code: 0 })) as never,
  capture: async () => Buffer.alloc(6_000, 7),
};

let tmp: string;
let fetchStub: ReturnType<typeof stubFetch>;
let undoCreatives: () => void;
const envKeys = ["WHATSAPP_GATEWAY_URL", "WHATSAPP_GATEWAY_TOKEN", "WHATSAPP_WEBHOOK_SECRET", "PUBLIC_BASE_URL", "INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_BUSINESS_ID", "SITE_PREVIEW_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.WHATSAPP_GATEWAY_URL = "http://gateway.test";
  process.env.WHATSAPP_GATEWAY_TOKEN = "t".repeat(24);
  process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
  delete process.env.WHATSAPP_SESSION_ID;
  process.env.PUBLIC_BASE_URL = "https://crm.exemplo.com";
  process.env.INSTAGRAM_ACCESS_TOKEN = "token-de-teste-longo";
  process.env.INSTAGRAM_BUSINESS_ID = "17841400000000";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-funil-"));
  process.env.SITE_PREVIEW_DIR = path.join(tmp, "previews");
  registerAgentHandlers();
  reset();
  undoCreatives = installCreativeFakes();
  siteBuildTestHooks.browser = siteBrowser;
  fetchStub = stubFetch();
  await connectedLink();
  await setGloballyEnabled(true);
  // Todos os agentes em automático, MENOS o Analista de Presença, que numa rodada do relógio abriria páginas de verdade.
  for (const id of AGENT_IDS) await saveSettings(id, { mode: id === "presence" || id === "niche-analyst" ? "pausado" : "automatico" });
  await saveSettings("seller", { mode: "automatico", config: ALWAYS_OPEN });
});

afterEach(() => {
  fetchStub.restore();
  undoCreatives();
  siteBuildTestHooks.browser = undefined;
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("funil ponta a ponta em modo automático (WhatsApp simulado)", () => {
  it("Agente 2: o relógio dispara a prospecção sozinho e os leads entram na campanha do agente, sem site", async () => {
    await saveSettings("prospector", { mode: "automatico", config: { sweep: true, sweep_niches: 1, quantity_per_run: 10 } });
    const planned = await planAgents();
    assert.ok(planned.enqueued >= 1, "ninguém enfileirou nada à mão: o planejador decidiu");
    await runAgentQueue({ agents: ["prospector"], budgetMs: 30_000 });
    const tasks = await agentRepo().list("tasks", { where: { agent: "prospector" } });
    assert.ok(tasks.length >= 1 && tasks.every((t) => t.status === "concluido"), JSON.stringify(tasks.map((t) => [t.status, t.last_error])));
    const found = getDb().leads.filter((l) => l.campaign_id !== null && l.campaign_id !== "cmp_agent" && getDb().campaigns.find((c) => c.id === l.campaign_id)?.name.startsWith("AgentOS ·"));
    assert.ok(found.length > 0, "a prospecção achou empresas");
    assert.ok(found.every((l) => !l.website && l.phone), "só empresas sem site e com telefone");
    assert.equal(getAgentData().approvals.length, 0, "nenhum pedido de aprovação em automático");
  });

  it("Agentes 3 → 4 → 5: do dossiê à prévia do site, sem nenhuma aprovação, e a única mensagem ao dono é a da reunião (mais o aviso da prévia)", async () => {
    const lead = mkLead();
    const { sent, deps } = outbox();

    // Agente 3 — dossiê: a ficha do Maps comprova o perfil; nenhuma página é aberta (lead sem site).
    const dossier = await buildDossierForLead(lead.id, { fetchPage: (async () => ({ ok: false, status: 0, html: "", finalUrl: "", error: "sem site" })) as never, sleep: async () => undefined });
    assert.ok(dossier.profile && dossier.confidence >= 40);

    // Agente 4 — o relógio escolhe, confere o WhatsApp e escreve; o envio é a política de envio, não uma permissão.
    const p1 = await planAgents();
    assert.ok(p1.enqueued >= 1);
    await runAgentQueue({ agents: ["seller"], budgetMs: 20_000 });
    assert.equal(getAgentData().approvals.filter((a) => a.kind === "outreach_message").length, 0, "automático: não pede permissão para abordar");
    const first = await processDueOutreach(deps);
    assert.equal(first.sent, 1);
    assert.equal(sent[0]!.to, phoneOf(lead));
    assert.equal(lead.status, "contatado");
    await ageOutbox();

    // O lead responde com interesse: o agente responde sozinho, com dois horários.
    await leadSays(phoneOf(lead), "Gostei! Como funciona isso?");
    await runAgentQueue({ agents: ["seller"], budgetMs: 20_000 });
    assert.equal(getAgentData().approvals.filter((a) => a.kind === "conversation_reply").length, 0, "automático: não pede permissão para responder");
    assert.equal((await processDueOutreach(deps)).sent, 1);
    const slots = (await getConversationState(lead.id))!.proposed_slots;
    assert.equal(slots.length, 2);

    // O lead marca a reunião: é o ÚNICO motivo para uma mensagem ao WhatsApp do dono vinda do Vendedor.
    await leadSays(phoneOf(lead), "o primeiro");
    await runAgentQueue({ agents: ["seller"], budgetMs: 20_000 });
    assert.equal(getAgentData().meetings.length, 1);
    assert.equal(lead.status, "reuniao");
    const reuniao = getAgentData().owner_notices.filter((n) => n.kind === "reuniao");
    assert.equal(reuniao.length, 1);
    assert.equal(await processDueOwnerNotices(deps), 1);
    const toOwner = sent.filter((m) => m.to === OWNER);
    assert.equal(toOwner.length, 1, "uma única mensagem ao dono até aqui: a da reunião");
    assert.match(toOwner[0]!.body, /Clínica Aurora/);
    assert.ok(sent.filter((m) => m.to !== OWNER).every((m) => m.to === phoneOf(lead)), "o resto vai só ao lead");

    // Agente 5 — o sinal verde é a reunião marcada: a prévia sai sozinha, verificada.
    const p2 = await planAgents();
    assert.ok(p2.enqueued >= 1, "o Programador de Sites entrou sozinho");
    await runAgentQueue({ agents: ["site-builder"], budgetMs: 30_000 });
    const [build] = getAgentData().site_builds;
    assert.equal(build!.status, "pronto", build!.error ?? "");
    assert.equal(build!.lead_id, lead.id);
    assert.ok(build!.checks.every((c) => c.ok));
    assert.ok(await readPreview(build!.token));
    assert.equal(getAgentData().approvals.filter((a) => a.kind !== "agent_task").length, 0, "nenhum clique de aprovação no funil inteiro");

    // Quem interrompe o dono: reunião marcada (Agente 4) e prévia pronta (Agente 5), e nada mais.
    assert.deepEqual(getAgentData().owner_notices.map((n) => n.kind).sort(), ["previa", "reuniao"]);
    assert.ok(getDb().notifications.some((n) => n.title.includes("Reunião marcada")), "e o sino também avisa");
  });

  it("o que o agente não resolve vai SÓ para o painel e o sino: mídia, mensagem vaga ou dúvida fora do roteiro não geram WhatsApp ao dono", async () => {
    const { sent, deps } = outbox();
    const leads = [mkLead(), mkLead(), mkLead()];
    // Já abordados (enviado há uma hora, para o intervalo mínimo ter passado).
    for (const l of leads) {
      const before = new Date(Date.now() - 3_600_000).toISOString();
      await agentRepo().insert("outreach_messages", { id: `omsg_f${++seq}`, organization_id: getDb().organization.id, lead_id: l.id, cycle_id: `cyc_f${seq}`, phone: phoneOf(l), body: "Abordagem", status: "DELIVERED", provider_message_id: `WA-OUT-${seq}`, error_detail: null, created_at: before, sent_at: before, delivered_at: before, read_at: null });
      Object.assign(l, { status: "contatado", last_contact_at: before });
    }
    await leadSays(phoneOf(leads[0]!), "", { media_type: "áudio", text: "[áudio]" });
    await leadSays(phoneOf(leads[1]!), "ok");
    await leadSays(phoneOf(leads[2]!), "Vocês trabalham com convênio odontológico e atendem aos domingos na zona rural?");
    await runAgentQueue({ agents: ["seller"], budgetMs: 20_000 });

    for (const l of leads) {
      const st = (await getConversationState(l.id))!;
      assert.equal(st.awaiting, "humano", `${l.company_name} passou para você`);
      assert.ok(st.attention_reason, "com o motivo, para o painel mostrar");
    }
    assert.ok(getDb().notifications.length >= 3, "o sino avisou");
    assert.equal(getAgentData().owner_notices.length, 0, "nenhuma mensagem ao WhatsApp do dono por ambiguidade");
    assert.equal((await processDueOutreach(deps)).sent, 0);
    assert.equal(sent.length, 0, "nada saiu para ninguém");
  });

  it("'pare' bloqueia na entrada, ANTES de qualquer modelo, mesmo com o agente em automático: nenhuma resposta é preparada", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-longo"; // um modelo configurado: se alguém o chamasse, o fetch simulado veria
    const lead = mkLead();
    const before = new Date(Date.now() - 3_600_000).toISOString();
    await agentRepo().insert("outreach_messages", { id: `omsg_f${++seq}`, organization_id: getDb().organization.id, lead_id: lead.id, cycle_id: `cyc_f${seq}`, phone: phoneOf(lead), body: "Abordagem", status: "DELIVERED", provider_message_id: `WA-OUT-${seq}`, error_detail: null, created_at: before, sent_at: before, delivered_at: before, read_at: null });
    Object.assign(lead, { status: "contatado" });
    await leadSays(phoneOf(lead), "PARE");
    await runAgentQueue({ agents: ["seller"], budgetMs: 20_000 });

    assert.equal(await isBlocked(phoneOf(lead)), true);
    assert.equal(lead.status, "perdido");
    assert.equal((await agentRepo().list("tasks", { where: { kind: "conversation.respond" } })).length, 0, "não existe tarefa de resposta");
    assert.deepEqual(fetchStub.calls.llm, [], "nenhum modelo foi chamado");
    assert.equal(getAgentData().outreach_cycles.filter((c) => c.status === "agendado").length, 0);
    assert.equal(getAgentData().owner_notices.length, 0);
  });

  it("Agentes 6 e 7 em automático só PROPÕEM: nada é publicado, ativado nem servido de fora, e nenhuma escrita vai ao Instagram", async () => {
    await planAgents();
    await runAgentQueue({ agents: ["traffic-manager", "social-media"], budgetMs: 60_000 });

    const { campaigns, posts } = { campaigns: getAgentData().ad_campaigns, posts: getAgentData().social_posts };
    assert.ok(campaigns.length >= 1, "o Gestor de Tráfego propôs uma campanha");
    assert.ok(posts.length >= 1, "as Mídias Sociais propuseram posts do calendário");
    assert.ok(campaigns.every((c) => c.status === "pendente" && c.activated_at === null), "nenhuma campanha ativa");
    assert.ok(posts.every((p) => p.status === "pendente" && p.published_at === null && p.scheduled_at === null), "nenhum post publicado nem agendado");
    assert.equal(getAgentData().creatives.every((c) => c.status === "pendente" || c.status === "falhou"), true, "nenhuma arte aprovada");
    for (const c of getAgentData().creatives) assert.equal(await publicCreativeFile(c.token, c.kind === "video" ? "creative.mp4" : "creative.png"), null, "nada é servido de fora antes do clique");
    assert.deepEqual(fetchStub.calls.graphWrites, [], "nenhuma escrita (POST) ao Instagram");
    assert.equal(getAgentData().ad_reports.length, 0, "nenhum gasto de anúncio registrado");
  });

  it("o interruptor geral para o funil inteiro: nada é planejado nem enviado", async () => {
    mkLead();
    await setGloballyEnabled(false);
    const report = await planAgents();
    assert.deepEqual(report, { enqueued: 0, approvals: 0 });
    const { sent, deps } = outbox();
    assert.equal((await processDueOutreach(deps)).sent, 0);
    assert.equal(sent.length, 0);
  });
});
