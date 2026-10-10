import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateSite } from "@/lib/site-generate";
import { SiteBuildGateError, siteBuildGate, type SiteGateResult } from "@/lib/site-gate";
import { verifySiteStatic } from "@/lib/site-verify";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { PermanentTaskError, enqueueAgentTask, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import { getSellerConfig, getSiteBuilderConfig } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { getConversationState } from "@/services/conversation/state";
import { emitEvent } from "@/services/events";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import { getDossier } from "@/services/presence/build";
import { verifyInBrowser, type BrowserDeps } from "@/services/sites/browser";
import type { Lead } from "@/types";
import type { OwnerNotice, SiteBuild, SiteCheck } from "@/types/agents";

/**
 * Prévia do site (Agente 5).
 *
 * O fluxo, sempre nesta ordem e sempre com a porta (`siteBuildGate`) conferida
 * de novo a cada passo:
 *   enfileirar → gerar a página a partir do dossiê → verificar (arquivo + navegador)
 *   → publicar a prévia num endereço não adivinhável → avisar.
 * Se qualquer verificação falhar, a prévia não é entregue.
 */

export const SITE_BUILD = "site.build";
const ACTIVE: SiteBuild["status"][] = ["na_fila", "construindo", "verificando"];

/** Onde ficam os arquivos das prévias (fora de `src/`, no mesmo lugar dos outros dados locais). */
export function previewRoot(): string {
  return process.env.SITE_PREVIEW_DIR ?? path.join(process.cwd(), ".data", "site-previews");
}

export const isToken = (t: string): boolean => /^[a-f0-9]{48}$/.test(t);
export const previewDir = (token: string): string => path.join(previewRoot(), token);
export const newToken = (): string => crypto.randomBytes(24).toString("hex");

/* ------------------------------------------------------------------ */
/* Porta                                                               */
/* ------------------------------------------------------------------ */

export async function evaluateGate(leadId: string, now: Date = new Date()): Promise<{ lead: Lead | null; gate: SiteGateResult }> {
  await ensureLeadsLoaded();
  const lead = getDb().leads.find((l) => l.id === leadId) ?? null;
  if (!lead) return { lead: null, gate: { ok: false, code: "status", reason: "Lead não encontrado." } };
  const [state, meetings, dossier, cfg] = await Promise.all([
    getConversationState(lead.id),
    agentRepo().list("meetings", { where: { lead_id: lead.id } }),
    getDossier(lead.id),
    getSiteBuilderConfig(),
  ]);
  return { lead, gate: siteBuildGate({ lead, state, meetings, dossier, now, marginHours: cfg.deadline_margin_hours }) };
}

function bell(title: string, body: string) {
  const db = getDb();
  const userId = db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (!userId) return;
  db.notifications.unshift({ id: uid("ntf"), organization_id: db.organization.id, user_id: userId, title, body, link: "/agentes/site-builder", read: false, created_at: new Date().toISOString() });
  saveDb();
}

/* ------------------------------------------------------------------ */
/* Registro da construção                                              */
/* ------------------------------------------------------------------ */

async function createRow(lead: Lead, gate: Extract<SiteGateResult, { ok: true }>, now: Date): Promise<SiteBuild> {
  const iso = now.toISOString();
  const build: SiteBuild = {
    id: uid("sbd"),
    organization_id: orgId(),
    lead_id: lead.id,
    meeting_id: gate.meeting.id,
    status: "na_fila",
    builder: "modelos",
    token: newToken(),
    content_hash: null,
    checks: [],
    screenshots: [],
    error: null,
    deadline_at: gate.deadline.toISOString(),
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
    ready_at: null,
    expires_at: null,
  };
  await agentRepo().insert("site_builds", build);
  return build;
}

/**
 * Pede a construção da prévia de um lead. **Lança `SiteBuildGateError`** se a porta
 * não estiver aberta: sem interesse explícito registrado e reunião futura, nada começa.
 */
export async function enqueueSiteBuild(leadId: string, opts: { now?: Date; createdBy?: string | null; force?: boolean } = {}): Promise<{ build: SiteBuild; created: boolean }> {
  const now = opts.now ?? new Date();
  const { lead, gate } = await evaluateGate(leadId, now);
  if (!lead || !gate.ok) throw new SiteBuildGateError(gate.ok ? "status" : gate.code, gate.ok ? "Lead não encontrado." : gate.reason);

  const mine = await agentRepo().list("site_builds", { where: { lead_id: lead.id }, orderBy: "created_at", desc: true });
  const active = mine.find((b) => ACTIVE.includes(b.status));
  if (active) return { build: active, created: false };
  const ready = mine.find((b) => b.status === "pronto" && b.meeting_id === gate.meeting.id && (b.expires_at ?? "") > now.toISOString());
  if (ready && !opts.force) return { build: ready, created: false };

  const build = await createRow(lead, gate, now);
  await enqueueAgentTask({ agent: "site-builder", kind: SITE_BUILD, payload: { lead_id: lead.id, build_id: build.id }, dedupeKey: `${SITE_BUILD}:${build.id}`, createdBy: opts.createdBy ?? null });
  await logAgentEvent("site-builder", "info", "site.queued", `Prévia do site de ${lead.company_name} na fila.`, { lead_id: lead.id, build_id: build.id });
  return { build, created: true };
}

/* ------------------------------------------------------------------ */
/* Construção                                                          */
/* ------------------------------------------------------------------ */

/** Só para testes: troca o navegador real por um simulado quando a chamada não passa o seu. */
export const siteBuildTestHooks: { browser?: BrowserDeps } = {};

export interface RunBuildDeps {
  now?: () => Date;
  browser?: BrowserDeps;
}

async function fail(build: SiteBuild, error: string, checks: SiteCheck[] = [], now: Date = new Date()): Promise<SiteBuild> {
  fs.rmSync(previewDir(build.token), { recursive: true, force: true });
  const updated = await agentRepo().update("site_builds", build.id, { status: "falhou", error, checks, screenshots: [], updated_at: now.toISOString() });
  await logAgentEvent("site-builder", "error", "site.failed", `Prévia não entregue: ${error}`, { build_id: build.id, lead_id: build.lead_id });
  return updated ?? { ...build, status: "falhou", error };
}

export async function runSiteBuild(buildId: string, deps: RunBuildDeps = {}): Promise<SiteBuild> {
  const repo = agentRepo();
  const clock = deps.now ?? (() => new Date());
  const build = await repo.get("site_builds", buildId);
  if (!build) throw new PermanentTaskError("Construção não encontrada.");
  if (build.status === "pronto" || build.status === "cancelado") return build;

  // A porta é conferida de novo AQUI: o que valia ao enfileirar pode não valer mais.
  const { lead, gate } = await evaluateGate(build.lead_id, clock());
  if (!lead || !gate.ok) {
    const reason = gate.ok ? "Lead não encontrado." : gate.reason;
    if (!gate.ok && gate.code === "prazo") bell(`Sem tempo para a prévia de ${lead?.company_name ?? "um lead"}`, "A reunião está perto demais para uma prévia verificada. Nada foi entregue pela metade.");
    return fail(build, reason, [], clock());
  }
  const dossier = await getDossier(lead.id);
  const profile = dossier?.profile;
  if (!profile) return fail(build, "O dossiê não tem perfil: refaça o dossiê.", [], clock());

  await repo.update("site_builds", build.id, { status: "construindo", meeting_id: gate.meeting.id, deadline_at: gate.deadline.toISOString(), updated_at: clock().toISOString() });
  const dir = previewDir(build.token);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const site = generateSite(profile);
  const hash = crypto.createHash("sha256").update(site.html).digest("hex");
  fs.writeFileSync(path.join(dir, "index.html"), site.html, "utf8");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ lead_id: lead.id, build_id: build.id, builder: "modelos", content_hash: hash, built_at: clock().toISOString(), dossier_updated_at: dossier!.updated_at }, null, 2), "utf8");

  await repo.update("site_builds", build.id, { status: "verificando", content_hash: hash, updated_at: clock().toISOString() });
  const checks = verifySiteStatic(site.html, profile);
  const cfg = await getSiteBuilderConfig();
  const browser = await verifyInBrowser(site.html, dir, deps.browser ?? siteBuildTestHooks.browser);
  for (const c of browser.checks) {
    // Sem navegador e com a exigência desligada, registra o fato sem barrar.
    checks.push(!browser.available && !cfg.require_browser_check ? { ...c, ok: true, detail: `Ignorado por configuração. ${c.detail}` } : c);
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) return fail(build, `Verificação reprovada: ${failed.map((c) => c.name).join("; ")}.`, checks, clock());

  const now = clock();
  // Pronta, mas depois da reunião: não serve mais para o que foi pedido.
  if (now.getTime() >= Date.parse(gate.meeting.at)) return fail(build, "A prévia ficou pronta depois do horário da reunião.", checks, now);

  const keepUntil = new Date(Date.parse(gate.meeting.at) + cfg.keep_days_after_meeting * 86_400_000).toISOString();
  const ready = await repo.update("site_builds", build.id, {
    status: "pronto",
    checks,
    screenshots: browser.screenshots.map((s) => s.file),
    error: null,
    ready_at: now.toISOString(),
    expires_at: keepUntil,
    updated_at: now.toISOString(),
  });

  // Só uma prévia viva por lead: as anteriores saem do ar.
  for (const other of await repo.list("site_builds", { where: { lead_id: lead.id } })) {
    if (other.id !== build.id && other.status === "pronto") await discardSiteBuild(other.id);
  }

  logActivity(lead.id, "nota_adicionada", "Prévia do site pronta e verificada para a reunião.", null);
  saveDb();
  emitEvent("site.ready", lead, { payload: { build_id: build.id, deadline_at: gate.deadline.toISOString(), meeting_at: gate.meeting.at } });
  saveDb();
  bell(`Prévia do site de ${lead.company_name} pronta`, "Verificada e pronta para a reunião. Veja em Agentes › Programador de Sites.");
  await queuePreviewNotice(lead, build.id, gate.meeting.at);
  await logAgentEvent("site-builder", "info", "site.ready", `Prévia do site de ${lead.company_name} pronta e verificada (${checks.length} verificações).`, { build_id: build.id, lead_id: lead.id });
  return ready ?? build;
}

/** Aviso ao seu WhatsApp de que a prévia está pronta (e onde vê-la). */
async function queuePreviewNotice(lead: Lead, buildId: string, meetingAt: string) {
  const cfg = await getSellerConfig();
  if (!cfg.owner_phone) return;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const build = await agentRepo().get("site_builds", buildId);
  const when = new Date(meetingAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const lines = [`🖥️ Prévia do site de ${lead.company_name} pronta`, `Reunião: ${when}`, base && build ? `Ver: ${base}/previa/${build.token}` : "Ver: Agentes › Programador de Sites, no CRM."];
  const now = new Date().toISOString();
  const notice: OwnerNotice = {
    id: uid("onot"),
    organization_id: orgId(),
    kind: "previa",
    lead_id: lead.id,
    meeting_id: null,
    phone: cfg.owner_phone,
    body: lines.join("\n"),
    status: "pendente",
    attempts: 0,
    not_before: now,
    provider_message_id: null,
    last_error: null,
    idempotency_key: `previa:${buildId}`,
    created_at: now,
    updated_at: now,
    sent_at: null,
  };
  try {
    await agentRepo().insert("owner_notices", notice);
  } catch (err) {
    if (!(err instanceof UniqueViolationError)) throw err;
  }
}

/** Tira a prévia do ar e apaga os arquivos. */
export async function discardSiteBuild(buildId: string): Promise<SiteBuild | null> {
  const build = await agentRepo().get("site_builds", buildId);
  if (!build) return null;
  fs.rmSync(previewDir(build.token), { recursive: true, force: true });
  return agentRepo().update("site_builds", buildId, { status: "cancelado", screenshots: [], updated_at: new Date().toISOString() });
}

/** O HTML da prévia, só se ela está pronta e não expirou. Usado pela rota pública /previa/<token>. */
export async function readPreview(token: string, now: Date = new Date()): Promise<string | null> {
  if (!isToken(token)) return null;
  const [build] = await agentRepo().list("site_builds", { where: { token }, limit: 1 });
  if (!build || build.status !== "pronto" || !build.expires_at || build.expires_at <= now.toISOString()) return null;
  try {
    return fs.readFileSync(path.join(previewDir(token), "index.html"), "utf8");
  } catch {
    return null;
  }
}

/** Uma captura de tela da prévia (para o painel autenticado). */
export async function readScreenshot(buildId: string, name: string): Promise<Buffer | null> {
  if (!/^(desktop|mobile)\.png$/.test(name)) return null;
  const build = await agentRepo().get("site_builds", buildId);
  if (!build || build.status !== "pronto") return null;
  try {
    return fs.readFileSync(path.join(previewDir(build.token), "screens", name));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Tarefa                                                              */
/* ------------------------------------------------------------------ */

async function handler(ctx: AgentTaskContext): Promise<void> {
  const payload = ctx.task.payload as { lead_id?: string; build_id?: string };
  if (!payload.lead_id) throw new PermanentTaskError("Tarefa sem lead.");

  let buildId = payload.build_id;
  if (!buildId) {
    // Veio do planejador: a porta decide se há construção a fazer.
    const { build } = await enqueueRowOnly(payload.lead_id);
    buildId = build.id;
  }
  const build = await runSiteBuild(buildId);
  ctx.setResult({ build_id: build.id, status: build.status, error: build.error, checks: build.checks.filter((c) => !c.ok).map((c) => c.name) });
  if (build.status === "falhou") throw new PermanentTaskError(build.error ?? "Prévia não entregue.");
}

/** Cria só o registro (a tarefa que o chamou já existe). */
async function enqueueRowOnly(leadId: string): Promise<{ build: SiteBuild }> {
  const now = new Date();
  const { lead, gate } = await evaluateGate(leadId, now);
  if (!lead || !gate.ok) throw new PermanentTaskError(gate.ok ? "Lead não encontrado." : gate.reason);
  const mine = await agentRepo().list("site_builds", { where: { lead_id: lead.id } });
  const active = mine.find((b) => ACTIVE.includes(b.status));
  if (active) return { build: active };
  return { build: await createRow(lead, gate, now) };
}

export function registerSiteBuildHandlers() {
  registerAgentHandler(SITE_BUILD, handler);
}
