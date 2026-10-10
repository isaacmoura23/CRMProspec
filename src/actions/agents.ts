"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  citySchema,
  MAX_CITIES,
  normalizeFilters,
  normalizeNicheAnalystConfig,
  normalizeProspectorConfig,
  normalizeSellerConfig,
} from "@/agents/config";
import { normalizeBrazilianPhone } from "@/lib/outreach-policy";
import { blockPhone, unblockPhone } from "@/services/outreach/blocklist";
import { NICHE_ANALYZE, SUPPORTED_NICHES } from "@/agents/niche/agent";
import { PROSPECT_RUN } from "@/agents/prospector/agent";
import { getAdminUser, getWriterUser } from "@/lib/auth";
import { ADMIN_DENIED, WRITE_DENIED } from "@/lib/permissions";
import { decideApproval } from "@/services/agents/approvals";
import { logAgentEvent } from "@/services/agents/log";
import { cancelAgentTask, enqueueAgentTask } from "@/services/agents/queue";
import { agentRepo } from "@/services/agents/repository";
import {
  getAgentMode,
  getNicheAnalystConfig,
  getSellerConfig,
  isGloballyEnabled,
  saveSettings,
  setGloballyEnabled,
} from "@/services/agents/settings";
import { getDb, saveDb } from "@/lib/store";
import { logActivity } from "@/services/activity";
import { cancelPendingForLead, getConversationState, patchConversationState } from "@/services/conversation/state";
import { whatsappGateway } from "@/services/whatsapp/config";
import { DOSSIER_BUILD } from "@/services/presence/build";
import { normalizePresenceConfig, normalizeSiteBuilderConfig } from "@/agents/config";
import { SiteBuildGateError } from "@/lib/site-gate";
import { discardSiteBuild, enqueueSiteBuild } from "@/services/sites/build";
import { AGENT_MODES, isAgentId, type AgentId } from "@/types/agents";

/**
 * Ações do dashboard dos agentes. Toda verificação roda aqui, no servidor:
 * esconder um botão é conveniência, quem recusa é a action.
 *
 *   - configurar, mudar modo, ligar/desligar tudo, aprovar e fixar/banir
 *     nichos: owner e admin;
 *   - "executar agora" e cancelar tarefa: qualquer perfil de escrita (o clique
 *     de uma pessoa já é a aprovação da execução).
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });
const ok = (message?: string): ActionResult => ({ ok: true, message });

function refresh() {
  revalidatePath("/agentes", "layout");
}

export async function setGlobalSwitch(enabled: boolean): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  await setGloballyEnabled(Boolean(enabled));
  await logAgentEvent("sistema", "info", "global.switch", enabled ? `${admin.name} religou os agentes.` : `${admin.name} desligou todos os agentes.`);
  refresh();
  return ok(enabled ? "Agentes ligados." : "Todos os agentes foram desligados.");
}

export async function setAgentMode(agent: string, mode: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  if (!isAgentId(agent)) return fail("Agente desconhecido.");
  if (!(AGENT_MODES as readonly string[]).includes(mode)) return fail("Modo inválido.");
  await saveSettings(agent, { mode: mode as (typeof AGENT_MODES)[number] });
  await logAgentEvent(agent, "info", "agent.mode", `${admin.name} mudou o modo para ${mode}.`);
  refresh();
  return ok("Modo atualizado.");
}

const nicheConfigSchema = z.object({
  cities: z.array(citySchema).max(MAX_CITIES),
  niches: z.array(z.string().max(60)).max(40),
  sample_size: z.number().int().min(5).max(60),
  probe_sites: z.number().int().min(0).max(20),
  max_places_requests_day: z.number().int().min(0).max(500),
});

export async function saveNicheAnalystConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = nicheConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise cidades e limites.");
  const known = new Set(SUPPORTED_NICHES.map((n) => n.key));
  const config = normalizeNicheAnalystConfig({
    ...parsed.data,
    niches: parsed.data.niches.filter((n) => known.has(n)),
  });
  await saveSettings("niche-analyst", { config: { ...config } });
  refresh();
  return ok("Configuração salva.");
}

const prospectorConfigSchema = z.object({
  quantity_per_run: z.number().int().min(1).max(100),
  daily_leads_cap: z.number().int().min(0).max(500),
  max_places_requests_day: z.number().int().min(0).max(1000),
  min_niche_score: z.number().int().min(0).max(100),
  cooldown_days: z.number().int().min(0).max(90),
  filters: z.record(z.string(), z.boolean()),
  sweep: z.boolean().optional(),
  sweep_scope: z.enum(["capitais", "principais"]).optional(),
  sweep_niches: z.number().int().min(1).max(10).optional(),
});

export async function saveProspectorConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = prospectorConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise os limites.");
  const config = normalizeProspectorConfig({ ...parsed.data, filters: normalizeFilters(parsed.data.filters) });
  await saveSettings("prospector", { config: { ...config } });
  refresh();
  return ok("Configuração salva.");
}

const sellerConfigSchema = z.object({
  send_days: z.array(z.number().int().min(1).max(7)).max(7),
  start_hour: z.number().int().min(0).max(23),
  end_hour: z.number().int().min(1).max(24),
  daily_cap_max: z.number().int().min(0).max(200),
  warmup: z.boolean(),
  min_gap_seconds: z.number().int().min(10).max(3600),
  max_gap_seconds: z.number().int().min(10).max(7200),
  touch_spacing_days: z.array(z.number().int().min(1).max(30)).min(1).max(2),
  max_touches: z.number().int().min(1).max(3),
  min_lead_score: z.number().int().min(0).max(100),
  lookups_per_day: z.number().int().min(0).max(500),
  max_pending_approvals: z.number().int().min(1).max(50),
  only_agent_leads: z.boolean(),
  require_dossier: z.boolean().optional(),
});

export async function saveSellerConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = sellerConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise a janela, os tetos e os intervalos.");
  if (parsed.data.send_days.length === 0) return fail("Escolha ao menos um dia da semana para enviar.");
  if (parsed.data.end_hour <= parsed.data.start_hour) return fail("O horário final precisa ser depois do inicial.");
  // A política de envio não mexe nos horários de reunião nem no número do dono: os valores atuais são mantidos.
  const current = await getSellerConfig();
  await saveSettings("seller", { config: { ...normalizeSellerConfig({ ...current, ...parsed.data }) } });
  await logAgentEvent("seller", "info", "agent.config", `${admin.name} atualizou a política de envio.`);
  refresh();
  return ok("Política de envio salva.");
}

const conversationConfigSchema = z.object({
  meeting_days: z.array(z.number().int().min(1).max(7)).max(7),
  meeting_start_hour: z.number().int().min(0).max(23),
  meeting_end_hour: z.number().int().min(1).max(24),
  meeting_min_notice_hours: z.number().int().min(1).max(168),
  meeting_duration_min: z.number().int().min(10).max(120),
  owner_phone: z.string().trim().max(30),
});

export async function saveConversationConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = conversationConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise os dias, os horários e o telefone.");
  const d = parsed.data;
  if (d.meeting_days.length === 0) return fail("Escolha ao menos um dia da semana para reuniões.");
  if (d.meeting_end_hour <= d.meeting_start_hour) return fail("O horário final precisa ser depois do inicial.");

  let ownerPhone: string | null = null;
  let warning = "";
  if (d.owner_phone) {
    ownerPhone = normalizeBrazilianPhone(d.owner_phone);
    if (!ownerPhone) return fail("Telefone do aviso inválido. Use o formato brasileiro, com DDD (ex.: (41) 99999-8888).");
    // O número precisa ter WhatsApp: confere agora, se o gateway estiver de pé.
    const gateway = whatsappGateway();
    try {
      if (gateway && (await gateway.status()).status === "CONNECTED") {
        if (!(await gateway.recipient(ownerPhone)).exists) return fail("Esse número não tem WhatsApp. Confira o telefone.");
      } else {
        warning = " Não deu para confirmar o WhatsApp agora (gateway desconectado): ele será conferido no primeiro aviso.";
      }
    } catch {
      warning = " Não deu para confirmar o WhatsApp agora: ele será conferido no primeiro aviso.";
    }
  }

  const current = await getSellerConfig();
  await saveSettings("seller", { config: { ...normalizeSellerConfig({ ...current, ...d, owner_phone: ownerPhone }) } });
  await logAgentEvent("seller", "info", "agent.config", `${admin.name} atualizou as reuniões e o aviso ao WhatsApp.`);
  refresh();
  return ok(`Configuração de reuniões salva.${warning}`);
}

const presenceConfigSchema = z.object({
  dossiers_per_day: z.number().int().min(0).max(300),
  refresh_days: z.number().int().min(1).max(180),
  min_lead_score: z.number().int().min(0).max(100),
  only_agent_leads: z.boolean(),
  fetch_delay_ms: z.number().int().min(0).max(10_000),
  visual: z.boolean(),
});

export async function savePresenceConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = presenceConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise os limites.");
  await saveSettings("presence", { config: { ...normalizePresenceConfig(parsed.data) } });
  await logAgentEvent("presence", "info", "agent.config", `${admin.name} atualizou a configuração do Analista de Presença Digital.`);
  refresh();
  return ok("Configuração salva.");
}

const siteBuilderConfigSchema = z.object({
  deadline_margin_hours: z.number().int().min(1).max(72),
  keep_days_after_meeting: z.number().int().min(1).max(60),
  require_browser_check: z.boolean(),
});

export async function saveSiteBuilderConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = siteBuilderConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise os limites.");
  await saveSettings("site-builder", { config: { ...normalizeSiteBuilderConfig(parsed.data) } });
  await logAgentEvent("site-builder", "info", "agent.config", `${admin.name} atualizou a configuração do Programador de Sites.`);
  refresh();
  return ok("Configuração salva.");
}

/**
 * Constrói a prévia do site de um lead agora. A porta é a mesma do agente: sem interesse
 * explícito registrado e reunião futura, a resposta é a razão da recusa — não há atalho.
 */
export async function buildSiteNow(leadId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const blocked = await assertCanRun("site-builder");
  if (blocked) return fail(blocked);
  try {
    const { created } = await enqueueSiteBuild(String(leadId), { createdBy: user.id, force: true });
    refresh();
    return ok(created ? "Prévia na fila. Fica pronta em instantes." : "Já existe uma prévia deste lead em andamento.");
  } catch (err) {
    if (err instanceof SiteBuildGateError) return fail(err.message);
    throw err;
  }
}

/** Tira a prévia do ar e apaga os arquivos. */
export async function discardSitePreview(buildId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const build = await discardSiteBuild(String(buildId));
  if (!build) return fail("Prévia não encontrada.");
  await logAgentEvent("site-builder", "info", "site.discarded", `${user.name} tirou uma prévia do ar.`, { build_id: build.id });
  refresh();
  return ok("Prévia removida: o endereço deixou de abrir.");
}

/** Monta (ou refaz) o dossiê de um lead agora, sem esperar o planejador. */
export async function buildDossierNow(leadId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const lead = getDb().leads.find((l) => l.id === String(leadId));
  if (!lead) return fail("Lead não encontrado.");
  const blocked = await assertCanRun("presence");
  if (blocked) return fail(blocked);
  const { created } = await enqueueAgentTask({ agent: "presence", kind: DOSSIER_BUILD, payload: { lead_id: lead.id }, dedupeKey: `manual:${DOSSIER_BUILD}:${lead.id}`, createdBy: user.id });
  refresh();
  return ok(created ? "Dossiê na fila. Fica pronto em instantes." : "Já existe um dossiê deste lead na fila.");
}

/** Você assume a conversa: o agente para de escrever nesse lead e o que ele tinha a caminho é cancelado. */
export async function takeOverConversation(leadId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const lead = getDb().leads.find((l) => l.id === String(leadId));
  if (!lead) return fail("Lead não encontrado.");
  await patchConversationState(lead.id, { control: "humano", control_reason: `${user.name} assumiu a conversa`, awaiting: "nada", attention_reason: null, proposed_slots: [] });
  const cancelled = await cancelPendingForLead(lead.id, "você assumiu a conversa");
  logActivity(lead.id, "nota_adicionada", `${user.name} assumiu a conversa: o Vendedor parou de escrever neste lead.`, user.id);
  saveDb();
  await logAgentEvent("seller", "info", "conversation.taken_over", `${user.name} assumiu a conversa com ${lead.company_name} (${cancelled.cycles + cancelled.approvals + cancelled.tasks} item(ns) cancelado(s)).`, { lead_id: lead.id });
  refresh();
  return ok("Conversa assumida. O Vendedor não escreve mais neste lead.");
}

/** Devolve a conversa ao agente: ele volta a tratar o que o lead escrever dali em diante. */
export async function returnConversation(leadId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const lead = getDb().leads.find((l) => l.id === String(leadId));
  if (!lead) return fail("Lead não encontrado.");
  if ((await getConversationState(lead.id))?.control !== "humano") return fail("Esta conversa já está com o agente.");
  await patchConversationState(lead.id, { control: "agente", control_reason: null, awaiting: "nada", attention_reason: null });
  await logAgentEvent("seller", "info", "conversation.returned", `${user.name} devolveu a conversa com ${lead.company_name} ao agente.`, { lead_id: lead.id });
  refresh();
  return ok("Conversa devolvida ao agente.");
}

/** Tira o alerta de "precisa de você" depois de resolvido por fora (sem devolver nem assumir). */
export async function dismissAttention(leadId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const state = await getConversationState(String(leadId));
  if (!state || state.awaiting !== "humano") return fail("Nada pendente nesta conversa.");
  await patchConversationState(state.lead_id, { awaiting: "nada", attention_reason: null });
  refresh();
  return ok("Pronto, alerta removido.");
}

export async function setMeetingStatus(meetingId: string, status: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  if (status !== "realizada" && status !== "cancelada") return fail("Estado inválido.");
  const repo = agentRepo();
  const meeting = await repo.get("meetings", String(meetingId));
  if (!meeting) return fail("Reunião não encontrada.");
  await repo.update("meetings", meeting.id, { status, updated_at: new Date().toISOString() });
  await logAgentEvent("seller", "info", "meeting.updated", `${user.name} marcou a reunião como ${status}.`, { meeting_id: meeting.id });
  refresh();
  return ok(status === "realizada" ? "Reunião marcada como realizada." : "Reunião cancelada.");
}

const blockSchema = z.object({ phone: z.string().trim().min(8).max(30), reason: z.string().trim().max(120).optional() });

export async function blockNumber(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = blockSchema.safeParse(input);
  if (!parsed.success) return fail("Informe um telefone.");
  const phone = normalizeBrazilianPhone(parsed.data.phone);
  if (!phone) return fail("Telefone inválido. Use o formato brasileiro, com DDD (ex.: (41) 99999-8888).");
  await blockPhone(phone, parsed.data.reason || "bloqueio manual", "manual");
  refresh();
  return ok("Número bloqueado: nenhuma mensagem será enviada a ele.");
}

export async function unblockNumber(phone: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const removed = await unblockPhone(String(phone));
  refresh();
  return removed ? ok("Número liberado.") : fail("O número não estava na lista.");
}

/** Recusa executar para agente pausado ou com tudo desligado: a tarefa ficaria parada sem ninguém saber. */
async function assertCanRun(agent: AgentId): Promise<string | null> {
  if (!(await isGloballyEnabled())) return "Os agentes estão desligados. Ligue-os no interruptor geral.";
  if ((await getAgentMode(agent)) === "pausado") return "Este agente está pausado. Mude o modo para executar.";
  return null;
}

export async function runNicheAnalysisNow(): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const blocked = await assertCanRun("niche-analyst");
  if (blocked) return fail(blocked);
  if ((await getNicheAnalystConfig()).cities.length === 0) {
    return fail("Cadastre ao menos uma cidade antes de analisar.");
  }
  const { created } = await enqueueAgentTask({
    agent: "niche-analyst",
    kind: NICHE_ANALYZE,
    dedupeKey: `manual:${NICHE_ANALYZE}`,
    createdBy: user.id,
  });
  refresh();
  return ok(created ? "Análise na fila. Começa em instantes." : "Já existe uma análise na fila.");
}

const prospectNowSchema = z.object({
  niche: z.string().min(2).max(60),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(60).optional(),
  country: z.string().trim().min(2).max(60).default("Brasil"),
  quantity: z.number().int().min(1).max(100).optional(),
});

export async function prospectNow(input: unknown): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const parsed = prospectNowSchema.safeParse(input);
  if (!parsed.success) return fail("Informe nicho e cidade.");
  const niche = SUPPORTED_NICHES.find((n) => n.key === parsed.data.niche);
  if (!niche) return fail("Nicho não suportado pela fonte de empresas.");
  const blocked = await assertCanRun("prospector");
  if (blocked) return fail(blocked);

  const { created } = await enqueueAgentTask({
    agent: "prospector",
    kind: PROSPECT_RUN,
    payload: {
      niche: niche.key,
      niche_label: niche.label,
      city: parsed.data.city,
      state: parsed.data.state,
      country: parsed.data.country,
      quantity: parsed.data.quantity,
    },
    dedupeKey: `manual:${PROSPECT_RUN}:${niche.key}:${parsed.data.city.toLowerCase()}`,
    createdBy: user.id,
  });
  refresh();
  return ok(created ? "Prospecção na fila. Começa em instantes." : "Já existe uma prospecção igual na fila.");
}

export async function cancelTask(taskId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const task = await cancelAgentTask(taskId);
  if (!task) return fail("A tarefa já terminou ou não existe.");
  await logAgentEvent(task.agent, "info", "task.cancelled", `${user.name} cancelou ${task.kind}.`, null, task.id);
  refresh();
  return ok("Tarefa cancelada.");
}

/**
 * Aprovar ou recusar um pedido. `editedBody` só vale para mensagem de WhatsApp:
 * o texto editado pelo dono passa pelas mesmas barreiras do gerado.
 */
export async function decideAgentApproval(id: string, approve: boolean, editedBody?: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const body = typeof editedBody === "string" && editedBody.length <= 4000 ? editedBody : undefined;
  const result = await decideApproval(id, Boolean(approve), admin.id, { editedBody: body });
  refresh();
  if (!result.ok) return fail(result.error);
  if (!approve) return ok("Recusado.");
  return ok(result.approval.kind === "outreach_message" ? "Aprovado. A mensagem sai quando a política de envio permitir (janela, limite e intervalo)." : "Aprovado. A tarefa entrou na fila.");
}

export async function setNicheTargetStatus(id: string, status: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  if (status !== "auto" && status !== "fixado" && status !== "banido") return fail("Estado inválido.");
  const updated = await agentRepo().update("niche_targets", id, { status });
  if (!updated) return fail("Nicho não encontrado.");
  refresh();
  return ok(status === "fixado" ? "Nicho fixado: será priorizado." : status === "banido" ? "Nicho banido: não será prospectado." : "Nicho voltou ao automático.");
}
