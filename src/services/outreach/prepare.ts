import "server-only";
import { aiGenerateOutreach } from "@/ai";
import { AGENT_CAMPAIGN_PREFIX } from "@/agents/prospector/agent";
import { contactablePhone, leadEligibility, leadForMessage } from "@/lib/outreach-eligibility";
import { checkMessage, phoneKey, withOptOutFooter } from "@/lib/outreach-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { ProviderError } from "@/providers/whatsapp/types";
import { logAgentEvent, nextDayStart, spentToday } from "@/services/agents/log";
import { APPROVAL_TTL_MS } from "@/services/agents/approvals";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { analyzeAndStore } from "@/jobs/prospecting";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import { blockPhone, blockedKeys } from "@/services/outreach/blocklist";
import { createOutreachCycle } from "@/services/outreach/cycles";
import { humanLeadIds } from "@/services/conversation/state";
import { whatsappGateway } from "@/services/whatsapp/config";
import type { SellerConfig } from "@/agents/config";
import type { Lead, LeadAnalysis } from "@/types";
import type { Approval } from "@/types/agents";

/**
 * Preparação de uma abordagem: do lead escolhido até "mensagem pronta".
 *
 * Passos, todos sem efeito externo irreversível (nada é enviado aqui):
 *   1. o lead ainda pode ser abordado?  (elegibilidade pura)
 *   2. o número tem WhatsApp de verdade? (consulta ao gateway, com teto diário)
 *   3. escreve a mensagem com o motor de IA existente e passa pelas barreiras
 *   4. modo de aprovação → pedido com o texto exato; automático → ciclo de envio
 *
 * A mensagem é gerada com os dados que o CRM tem do lead (análise e perfil da
 * empresa). O dossiê de presença digital (Agente 3) ainda não existe, então a
 * personalização é a da análise — sem inventar nada além dela.
 */

export const OUTREACH_PREPARE = "outreach.prepare";
const RECHECK_MS = 5 * 60_000;

export async function agentCampaignIds(): Promise<Set<string>> {
  return new Set(getDb().campaigns.filter((c) => c.name.startsWith(AGENT_CAMPAIGN_PREFIX)).map((c) => c.id));
}

/** Dados do que já existe em volta dos leads, carregados uma vez para avaliar muitos. */
export async function loadOutreachContext() {
  const repo = agentRepo();
  const [blocked, cycles, approvals, campaigns, human] = await Promise.all([
    blockedKeys(),
    repo.list("outreach_cycles"),
    repo.list("approvals", { where: { kind: "outreach_message" } }),
    agentCampaignIds(),
    humanLeadIds(),
  ]);
  const byLead = <T extends { lead_id?: string }>(rows: T[], leadId: string) => rows.filter((r) => r.lead_id === leadId);
  return {
    blocked,
    campaigns,
    isHuman: (leadId: string) => human.has(leadId),
    cyclesOf: (leadId: string) => byLead(cycles, leadId),
    approvalsOf: (leadId: string) => approvals.filter((a) => (a.payload as { lead_id?: string }).lead_id === leadId),
  };
}

export interface ComposeResult {
  ok: boolean;
  body: string;
  reason: string | null;
}

/**
 * Escreve a mensagem e a passa pelas barreiras. Tenta até três variações do
 * texto: o motor determinístico varia a abertura, e um texto reprovado por
 * uma regra pode passar na variação seguinte.
 */
export async function composeBody(lead: Lead, analysis: LeadAnalysis, touch: number): Promise<ComposeResult> {
  const profile = getDb().company_profile;
  const safe = leadForMessage(lead);
  let reason: string | null = "não foi possível gerar a mensagem";
  for (const variant of [touch - 1, touch, touch + 1]) {
    const { content } = await aiGenerateOutreach(
      safe,
      analysis,
      profile,
      touch === 1 ? "whatsapp" : "follow_up",
      "padrao",
      variant,
      touch > 1 ? "A primeira mensagem foi enviada há alguns dias e ainda não houve resposta." : undefined
    );
    const body = withOptOutFooter(content);
    reason = checkMessage(body);
    if (!reason) return { ok: true, body, reason: null };
  }
  return { ok: false, body: "", reason };
}

/** Pedido de aprovação com o texto exato que vai sair. */
export async function createOutreachApproval(lead: Lead, touch: number, phone: string, body: string): Promise<Approval> {
  const now = Date.now();
  const approval: Approval = {
    id: uid("apv"),
    organization_id: orgId(),
    agent: "seller",
    kind: "outreach_message",
    title: `Mensagem para ${lead.company_name} (${touch}º toque)`,
    detail: `${lead.segment} · ${lead.city} · ${phone}`,
    payload: { lead_id: lead.id, touch, phone, body },
    dedupe_key: `outreach:${lead.id}:${touch}`,
    status: "pendente",
    decided_by: null,
    decided_at: null,
    task_id: null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
  await agentRepo().insert("approvals", approval);
  await logAgentEvent("seller", "info", "approval.requested", `Pediu aprovação da mensagem para ${lead.company_name} (${touch}º toque).`);
  return approval;
}

async function prepare(ctx: AgentTaskContext): Promise<void> {
  const payload = ctx.task.payload as { lead_id?: string; touch?: number };
  const touch = Number(payload.touch ?? 1);
  if (!payload.lead_id) throw new PermanentTaskError("Tarefa sem lead.");

  const [cfg, mode] = await Promise.all([getSellerConfig(), getAgentMode("seller")]);
  await ensureLeadsLoaded();
  const db = getDb();
  const lead = db.leads.find((l) => l.id === payload.lead_id);
  if (!lead) {
    ctx.setResult({ skipped: "lead não encontrado" });
    return;
  }

  // 1. Ainda pode ser abordado?
  const around = await loadOutreachContext();
  const why = leadEligibility({
    lead,
    touch,
    cfg,
    blocked: around.blocked,
    cycles: around.cyclesOf(lead.id),
    approvals: around.approvalsOf(lead.id),
    agentCampaignIds: around.campaigns,
    humanControl: around.isHuman(lead.id),
  });
  if (why) {
    ctx.setResult({ skipped: why });
    await ctx.log("info", `${lead.company_name}: ${why}.`);
    return;
  }

  // 2. Gateway de pé e conectado (sem isso não há como confirmar o número).
  const gateway = whatsappGateway();
  if (!gateway) throw new PermanentTaskError("O gateway do WhatsApp não está configurado.");
  const later = () => ctx.reschedule(new Date(Date.now() + RECHECK_MS));
  try {
    if ((await gateway.status()).status !== "CONNECTED") return later();
  } catch {
    return later();
  }

  // 3. O número tem WhatsApp de verdade? Consulta com teto diário.
  const phone = contactablePhone(lead)!;
  if ((await spentToday("seller", "whatsapp_lookups")) >= cfg.lookups_per_day) {
    await ctx.log("warn", `Teto diário de consultas de número atingido (${cfg.lookups_per_day}); ${lead.company_name} fica para amanhã.`);
    ctx.reschedule(nextDayStart());
    return;
  }
  let exists: boolean;
  try {
    exists = (await gateway.recipient(phone)).exists;
  } catch (err) {
    if (err instanceof ProviderError && (err.kind === "DISCONNECTED" || err.retryable || err.uncertain)) return later();
    throw err;
  }
  await ctx.spend("whatsapp_lookups", 1, `+${phoneKey(phone).slice(0, 4)}…`);
  if (!exists) {
    await blockPhone(phone, "sem WhatsApp (consulta antes da abordagem)", "invalid");
    lead.has_whatsapp = false;
    lead.updated_at = new Date().toISOString();
    logActivity(lead.id, "nota_adicionada", "Número sem WhatsApp: não será abordado por esse canal.", null);
    saveDb();
    ctx.setResult({ skipped: "número sem WhatsApp" });
    return;
  }
  lead.whatsapp = phone;
  lead.has_whatsapp = true;
  lead.updated_at = new Date().toISOString();
  saveDb();

  // 4. Escreve a mensagem (a análise do lead é a base; sem ela, gera uma agora).
  let analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
  if (!analysis) {
    await analyzeAndStore(lead, null);
    analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
  }
  if (!analysis) throw new PermanentTaskError(`Sem análise do lead ${lead.company_name}.`);
  const composed = await composeBody(lead, analysis, touch);
  if (!composed.ok) throw new PermanentTaskError(`A mensagem não passou pela política de envio: ${composed.reason}`);

  // 5. Modo de aprovação: só sai o que o dono aprovar. Automático: vira ciclo.
  if (mode === "aprovacao") {
    const approval = await createOutreachApproval(lead, touch, phone, composed.body);
    ctx.setResult({ approval_id: approval.id, lead: lead.company_name, touch });
    return;
  }
  const cycle = await createOutreachCycle({ leadId: lead.id, touch, phone, body: composed.body, approvalId: null });
  if (!cycle) {
    ctx.setResult({ skipped: "o lead já tem uma abordagem em andamento" });
    return;
  }
  await logAgentEvent("seller", "info", "outreach.scheduled", `Mensagem para ${lead.company_name} (${touch}º toque) agendada.`, { cycle_id: cycle.id });
  ctx.setResult({ cycle_id: cycle.id, lead: lead.company_name, touch });
}

/** Candidatos à primeira abordagem, do melhor score ao pior, já filtrados pela elegibilidade. */
export async function firstTouchCandidates(cfg: SellerConfig, limit: number): Promise<Lead[]> {
  const around = await loadOutreachContext();
  return getDb()
    .leads.filter(
      (lead) =>
        leadEligibility({
          lead,
          touch: 1,
          cfg,
          blocked: around.blocked,
          cycles: around.cyclesOf(lead.id),
          approvals: around.approvalsOf(lead.id),
          agentCampaignIds: around.campaigns,
          humanControl: around.isHuman(lead.id),
        }) === null
    )
    .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
    .slice(0, limit);
}

export function registerOutreachPrepareHandler() {
  registerAgentHandler(OUTREACH_PREPARE, prepare);
}
