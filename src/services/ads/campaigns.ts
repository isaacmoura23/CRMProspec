import "server-only";
import { canMoveCampaign, checkCampaign, evaluateSpendCaps, increasesSpend, type CampaignDraft } from "@/lib/ads-policy";
import { getDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { dayKey, logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getTrafficConfig } from "@/services/agents/settings";
import type { AdCampaign, AdCampaignStatus, AdReport } from "@/types/agents";

/**
 * Campanhas de anúncio: propor, aprovar o rascunho, ativar, ajustar orçamento e medir.
 *
 * Duas coisas são deliberadamente SÓ da ação do botão: `activateCampaign` e
 * `setCampaignBudget` (quando o valor sobe) — ambas conferem os tetos diário e
 * mensal aqui no servidor. Os agentes só chamam `proposeCampaign` e
 * `proposeBudgetChange`, que criam pedidos em `approvals` e não mexem em dinheiro.
 * O provedor padrão é "manual": você cria a campanha na plataforma de anúncios e o
 * CRM guarda o controle, os tetos e os relatórios.
 */

const neverSay = () => getDb().company_profile.never_say;
const TTL_MS = 3 * 86_400_000;

export interface SpendSummary {
  todaySpentCents: number;
  monthSpentCents: number;
  activeDailyCents: number;
  caps: { daily_cap_cents: number; monthly_cap_cents: number };
}

export async function spendSummary(now: Date = new Date()): Promise<SpendSummary> {
  const [reports, campaigns, caps] = await Promise.all([agentRepo().list("ad_reports"), agentRepo().list("ad_campaigns", { where: { status: "ativa" } }), getTrafficConfig()]);
  const today = dayKey(now);
  return {
    todaySpentCents: reports.filter((r) => r.day === today).reduce((n, r) => n + r.spend_cents, 0),
    monthSpentCents: reports.filter((r) => r.day.slice(0, 7) === today.slice(0, 7)).reduce((n, r) => n + r.spend_cents, 0),
    activeDailyCents: campaigns.reduce((n, c) => n + c.daily_budget_cents, 0),
    caps: { daily_cap_cents: caps.daily_cap_cents, monthly_cap_cents: caps.monthly_cap_cents },
  };
}

/** Cria o rascunho "pendente" e o pedido de aprovação. É o máximo que um agente alcança. */
export async function proposeCampaign(input: CampaignDraft & { objective: AdCampaign["objective"]; reason?: string }, now: Date = new Date()): Promise<AdCampaign> {
  const violation = checkCampaign(input, neverSay(), dayKey(now));
  if (violation) throw new Error(`Campanha reprovada: ${violation}`);
  const id = uid("adc");
  const iso = now.toISOString();
  const approvalId = uid("apv");
  const expires = new Date(now.getTime() + TTL_MS).toISOString();
  const campaign: AdCampaign = {
    id,
    organization_id: orgId(),
    name: input.name.trim(),
    objective: input.objective,
    platform: "manual",
    status: "pendente",
    daily_budget_cents: input.daily_budget_cents,
    start_date: input.start_date,
    end_date: input.end_date,
    audience: input.audience.trim(),
    headline: input.headline.trim(),
    body: input.body.trim(),
    cta: input.cta.trim(),
    landing_url: input.landing_url,
    approval_id: approvalId,
    external_id: null,
    idempotency_key: `campaign:${id}`,
    error: null,
    approved_by: null,
    approved_at: null,
    activated_by: null,
    activated_at: null,
    created_at: iso,
    updated_at: iso,
    expires_at: expires,
  };
  await agentRepo().insert("ad_campaigns", campaign);
  await agentRepo().insert("approvals", {
    id: approvalId,
    organization_id: orgId(),
    agent: "traffic-manager",
    kind: "ad_campaign",
    title: `Rascunho de campanha: ${campaign.name}`,
    detail: input.reason ?? null,
    payload: { campaign_id: id },
    dedupe_key: `ad_campaign:${id}`,
    status: "pendente",
    decided_by: null,
    decided_at: null,
    task_id: null,
    created_at: iso,
    expires_at: expires,
  });
  await logAgentEvent("traffic-manager", "info", "campaign.proposed", `Propôs o rascunho da campanha "${campaign.name}".`, { campaign_id: id });
  return campaign;
}

async function move(c: AdCampaign, to: AdCampaignStatus, patch: Partial<AdCampaign> = {}, now: Date = new Date()): Promise<AdCampaign> {
  if (!canMoveCampaign(c.status, to)) throw new Error(`Transição inválida de campanha: ${c.status} → ${to}`);
  return (await agentRepo().update("ad_campaigns", c.id, { ...patch, status: to, updated_at: now.toISOString() })) ?? { ...c, ...patch, status: to };
}

export type CampaignResult = { ok: true; campaign: AdCampaign } | { ok: false; error: string };

/** Aprovar o RASCUNHO: a campanha fica "aprovada", mas ainda não gasta nada — ativar é outro clique. */
export async function approveCampaignDraft(campaignId: string, userId: string, now: Date = new Date()): Promise<CampaignResult> {
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c) return { ok: false, error: "Campanha não encontrada." };
  if (c.status !== "pendente") return { ok: false, error: `A campanha está "${c.status}".` };
  if (c.expires_at <= now.toISOString()) {
    await move(c, "expirada", {}, now);
    return { ok: false, error: "A proposta expirou. O agente fará uma nova." };
  }
  const approved = await move(c, "aprovado", { approved_by: userId, approved_at: now.toISOString() }, now);
  if (c.approval_id) await agentRepo().update("approvals", c.approval_id, { status: "aprovado", decided_by: userId, decided_at: now.toISOString() });
  await logAgentEvent("traffic-manager", "info", "campaign.approved", `Rascunho aprovado: "${c.name}". Ainda não gasta nada: ativar é outro clique.`, { campaign_id: c.id });
  return { ok: true, campaign: approved };
}

export async function rejectCampaignDraft(campaignId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c || c.status !== "pendente") return false;
  await move(c, "recusada", {}, now);
  if (c.approval_id) await agentRepo().update("approvals", c.approval_id, { status: "recusado", decided_by: userId, decided_at: now.toISOString() });
  return true;
}

async function capsFor(campaignId: string, dailyCents: number, endDate: string | null, now: Date) {
  const [summary, active] = await Promise.all([spendSummary(now), agentRepo().list("ad_campaigns", { where: { status: "ativa" } })]);
  const other = active.filter((a) => a.id !== campaignId).reduce((n, a) => n + a.daily_budget_cents, 0);
  return evaluateSpendCaps({ campaignDailyCents: dailyCents, otherActiveDailyCents: other, spentMonthCents: summary.monthSpentCents, today: dayKey(now), endDate, caps: summary.caps });
}

/**
 * ATIVAR: a passagem que começa a gastar. Só a ação do botão a chama, e ela confere os tetos
 * (diário e mensal) com o gasto real do mês e as demais campanhas ativas.
 */
export async function activateCampaign(campaignId: string, userId: string, opts: { externalId?: string | null; now?: Date } = {}): Promise<CampaignResult> {
  const now = opts.now ?? new Date();
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c) return { ok: false, error: "Campanha não encontrada." };
  // O repositório local devolve o próprio objeto guardado, que a troca de estado altera no lugar: o estado de partida é lido já.
  const from = c.status;
  if (c.status !== "aprovado" && c.status !== "pausada") return { ok: false, error: `Só uma campanha aprovada ou pausada pode ser ativada (esta está "${c.status}").` };
  if (c.platform !== "manual") return { ok: false, error: "Esta plataforma ainda não está ligada: crie a campanha lá e use o modo manual." };
  const caps = await capsFor(c.id, c.daily_budget_cents, c.end_date, now);
  if (!caps.ok) {
    await logAgentEvent("traffic-manager", "warn", "campaign.blocked", `Ativação de "${c.name}" barrada pelo teto de gasto: ${caps.reason}`, { campaign_id: c.id, code: caps.code });
    return { ok: false, error: caps.reason };
  }
  // Troca atômica: dois cliques seguidos não ativam (nem somam ao gasto) duas vezes.
  const active = await agentRepo().claimStatus("ad_campaigns", c.id, from, { status: "ativa", activated_by: userId, activated_at: now.toISOString(), external_id: opts.externalId ?? c.external_id, error: null, updated_at: now.toISOString() });
  if (!active) return { ok: false, error: "Esta campanha já mudou de estado (talvez em outra aba)." };
  // Conferência depois da troca: se outra ativação passou junto, o teto vale para as duas — a que estourou volta atrás.
  const after = await capsFor(c.id, c.daily_budget_cents, c.end_date, now);
  if (!after.ok) {
    await agentRepo().claimStatus("ad_campaigns", c.id, "ativa", { status: from as AdCampaignStatus, activated_by: null, activated_at: null, updated_at: now.toISOString() });
    return { ok: false, error: after.reason };
  }
  await logAgentEvent("traffic-manager", "info", "campaign.activated", `Campanha "${c.name}" ativada por você (gasto previsto no mês: dentro do teto).`, { campaign_id: c.id });
  return { ok: true, campaign: active };
}

export async function pauseCampaign(campaignId: string, userId: string, now: Date = new Date()): Promise<CampaignResult> {
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c) return { ok: false, error: "Campanha não encontrada." };
  if (c.status !== "ativa") return { ok: false, error: `Só uma campanha ativa pode ser pausada (esta está "${c.status}").` };
  const paused = await move(c, "pausada", {}, now);
  await logAgentEvent("traffic-manager", "info", "campaign.paused", `Campanha "${c.name}" pausada por ${userId}.`, { campaign_id: c.id });
  return { ok: true, campaign: paused };
}

export async function endCampaign(campaignId: string, now: Date = new Date()): Promise<CampaignResult> {
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c) return { ok: false, error: "Campanha não encontrada." };
  if (!canMoveCampaign(c.status, "encerrada")) return { ok: false, error: `A campanha está "${c.status}".` };
  return { ok: true, campaign: await move(c, "encerrada", {}, now) };
}

/** Mudar o orçamento diário: subir confere os tetos (e só vale com clique); descer sempre pode. */
export async function setCampaignBudget(campaignId: string, newCents: number, userId: string, now: Date = new Date()): Promise<CampaignResult> {
  const c = await agentRepo().get("ad_campaigns", campaignId);
  if (!c) return { ok: false, error: "Campanha não encontrada." };
  if (!Number.isInteger(newCents) || newCents <= 0) return { ok: false, error: "O orçamento diário precisa ser maior que zero." };
  if (c.status !== "aprovado" && c.status !== "ativa" && c.status !== "pausada") return { ok: false, error: `Não dá para mudar o orçamento de uma campanha "${c.status}".` };
  if (increasesSpend(c, { daily_budget_cents: newCents }) && c.status === "ativa") {
    const caps = await capsFor(c.id, newCents, c.end_date, now);
    if (!caps.ok) {
      await logAgentEvent("traffic-manager", "warn", "campaign.blocked", `Aumento de orçamento de "${c.name}" barrado pelo teto de gasto: ${caps.reason}`, { campaign_id: c.id, code: caps.code });
      return { ok: false, error: caps.reason };
    }
  }
  const updated = (await agentRepo().update("ad_campaigns", c.id, { daily_budget_cents: newCents, updated_at: now.toISOString() })) ?? { ...c, daily_budget_cents: newCents };
  await logAgentEvent("traffic-manager", "info", "campaign.budget", `Orçamento de "${c.name}" ajustado por ${userId}.`, { campaign_id: c.id, from: c.daily_budget_cents, to: newCents });
  return { ok: true, campaign: updated };
}

/** Lança (ou corrige) o desempenho de uma campanha em um dia. */
export async function recordReport(input: { campaign_id: string; day: string; impressions: number; clicks: number; spend_cents: number; conversions: number; source?: AdReport["source"] }): Promise<AdReport> {
  const nums = [input.impressions, input.clicks, input.spend_cents, input.conversions];
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("Os números do relatório precisam ser inteiros e não negativos.");
  if (input.clicks > input.impressions && input.impressions > 0) throw new Error("Cliques não podem passar das impressões.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new Error("Data inválida.");
  if (!(await agentRepo().get("ad_campaigns", input.campaign_id))) throw new Error("Campanha não encontrada.");
  const report: AdReport = {
    id: `${input.campaign_id}:${input.day}`,
    organization_id: orgId(),
    campaign_id: input.campaign_id,
    day: input.day,
    impressions: input.impressions,
    clicks: input.clicks,
    spend_cents: input.spend_cents,
    conversions: input.conversions,
    source: input.source ?? "manual",
    created_at: new Date().toISOString(),
  };
  return agentRepo().upsert("ad_reports", report);
}

/** Pedido de mudança de orçamento ou de pausa: o agente propõe, o clique decide. */
export async function proposeBudgetChange(input: { campaign: AdCampaign; action: "pausar" | "ajustar"; toCents?: number; reason: string }, now: Date = new Date()): Promise<string | null> {
  const dedupe = `ad_budget_change:${input.campaign.id}:${input.action}:${dayKey(now)}`;
  if ((await agentRepo().list("approvals", { where: { dedupe_key: dedupe }, limit: 1 })).length > 0) return null;
  const id = uid("apv");
  const iso = now.toISOString();
  await agentRepo().insert("approvals", {
    id,
    organization_id: orgId(),
    agent: "traffic-manager",
    kind: "ad_budget_change",
    title: input.action === "pausar" ? `Pausar a campanha "${input.campaign.name}"?` : `Ajustar o orçamento de "${input.campaign.name}"?`,
    detail: input.reason,
    payload: { campaign_id: input.campaign.id, action: input.action, to_cents: input.toCents ?? null, from_cents: input.campaign.daily_budget_cents },
    dedupe_key: dedupe,
    status: "pendente",
    decided_by: null,
    decided_at: null,
    task_id: null,
    created_at: iso,
    expires_at: new Date(now.getTime() + TTL_MS).toISOString(),
  });
  await logAgentEvent("traffic-manager", "info", "approval.requested", `Pediu aprovação: ${input.action} "${input.campaign.name}".`, { campaign_id: input.campaign.id });
  return id;
}

/** Aplica um pedido de mudança aprovado (o clique já aconteceu): a ação de pausar ou ajustar passa pelos mesmos tetos. */
export async function applyBudgetChange(payload: { campaign_id: string; action: string; to_cents: number | null }, userId: string, now: Date = new Date()): Promise<CampaignResult> {
  if (payload.action === "pausar") return pauseCampaign(payload.campaign_id, userId, now);
  if (payload.action === "ajustar" && payload.to_cents) return setCampaignBudget(payload.campaign_id, payload.to_cents, userId, now);
  return { ok: false, error: "Pedido de mudança sem a ação ou o valor." };
}

/** Propostas sem decisão que passaram do prazo expiram. */
export async function expireStaleCampaigns(now: Date = new Date()): Promise<number> {
  const stale = (await agentRepo().list("ad_campaigns", { where: { status: "pendente" } })).filter((c) => c.expires_at <= now.toISOString());
  for (const c of stale) {
    await move(c, "expirada", {}, now);
    if (c.approval_id) await agentRepo().update("approvals", c.approval_id, { status: "expirado", decided_at: now.toISOString() });
  }
  return stale.length;
}
