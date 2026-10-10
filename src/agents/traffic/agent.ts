import "server-only";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import { checkCampaign, formatBrl } from "@/lib/ads-policy";
import { getDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { dayKey } from "@/services/agents/log";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo } from "@/services/agents/repository";
import { getTrafficConfig } from "@/services/agents/settings";
import { proposeBudgetChange, proposeCampaign, spendSummary } from "@/services/ads/campaigns";

/**
 * Agente 6 — Gestor de Tráfego.
 *
 * Propõe rascunhos de campanha (com a imagem do anúncio, feita em código) a partir do perfil da
 * empresa e, olhando os relatórios, propõe pausar ou ajustar. **Só propõe**: tudo vira pedido em
 * `approvals`; ativar, pausar e mexer em orçamento são ações do botão, dentro dos
 * tetos de gasto conferidos no servidor. Este arquivo só importa as funções de
 * proposta e de leitura — não as de ativar, pausar ou ajustar (um teste confere).
 */

export const ADS_PROPOSE = "ads.propose";
export const ADS_REVIEW = "ads.review";
const PROPOSE_EVERY_DAYS = 7;
/** Dias seguidos de gasto relevante sem nenhuma conversão para sugerir pausar. */
const WASTE_DAYS = 3;

function nextDay(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function propose(ctx: AgentTaskContext): Promise<void> {
  const profile = getDb().company_profile;
  const cfg = await getTrafficConfig();
  const services = (profile.main_services ?? []).filter((s) => s.trim());
  if (services.length === 0 || !profile.what_we_sell?.trim()) {
    ctx.setResult({ skipped: "perfil da empresa sem serviços" });
    await ctx.log("warn", "Complete o perfil da empresa (o que vende e os serviços): sem isso não há o que anunciar.");
    return;
  }
  const campaigns = await agentRepo().list("ad_campaigns", { orderBy: "created_at", desc: true, limit: 50 });
  const usedNames = new Set(campaigns.map((c) => c.name.toLowerCase()));
  const service = services.find((s) => !usedNames.has(`${s} — mensagens`.toLowerCase())) ?? services[0]!;

  // O orçamento sugerido é uma fração do teto diário: sobra espaço para outras campanhas.
  const daily = Math.max(500, Math.min(2_000, Math.floor(cfg.daily_cap_cents / 3 / 100) * 100));
  if (daily > cfg.daily_cap_cents) {
    ctx.setResult({ skipped: "teto diário abaixo do orçamento mínimo" });
    await ctx.log("warn", "O teto diário de gasto está abaixo do menor orçamento sugerido: ajuste o teto se quiser anunciar.");
    return;
  }
  const today = dayKey();
  const draft = {
    name: `${service} — mensagens`,
    headline: service.slice(0, 40),
    body: profile.what_we_sell.slice(0, 300).trim(),
    cta: "Fale conosco pelo WhatsApp",
    audience: (profile.target_customers || "Pessoas da região interessadas em " + service).slice(0, 300),
    daily_budget_cents: daily,
    start_date: nextDay(today),
    end_date: null,
    landing_url: null,
    objective: "mensagens" as const,
    reason: `Rascunho para divulgar "${service}" com orçamento de ${formatBrl(daily)} por dia (teto diário: ${formatBrl(cfg.daily_cap_cents)}). Nada é ativado sem o seu clique.`,
  };
  const violation = checkCampaign(draft, profile.never_say, today);
  if (violation) throw new PermanentTaskError(`O rascunho não passou nas barreiras: ${violation}`);
  // A imagem do anúncio é da própria empresa, feita em código; fica "pendente" até você aprovar a imagem.
  const campaign = await proposeCampaign(draft, new Date(), { builder: cfg.creative_builder, budgetUsd: cfg.creative_budget_usd });
  ctx.setResult({ campaign_id: campaign.id, name: campaign.name, daily_budget_cents: daily, creative_id: campaign.creative_id });
  await ctx.log("info", `Propôs o rascunho "${campaign.name}" (${formatBrl(daily)} por dia) com a imagem do anúncio.`);
}

/** Olha os relatórios e propõe — nunca executa — pausar o que gasta sem resultado ou tudo o que passou do teto. */
async function review(ctx: AgentTaskContext): Promise<void> {
  const [campaigns, reports, summary] = await Promise.all([agentRepo().list("ad_campaigns", { where: { status: "ativa" } }), agentRepo().list("ad_reports"), spendSummary()]);
  let proposals = 0;

  for (const c of campaigns) {
    const mine = reports.filter((r) => r.campaign_id === c.id).sort((a, b) => b.day.localeCompare(a.day)).slice(0, WASTE_DAYS);
    const spent = mine.reduce((n, r) => n + r.spend_cents, 0);
    if (mine.length >= WASTE_DAYS && spent >= c.daily_budget_cents && mine.every((r) => r.conversions === 0)) {
      const id = await proposeBudgetChange({ campaign: c, action: "pausar", reason: `Gastou ${formatBrl(spent)} em ${WASTE_DAYS} dias seguidos sem nenhuma conversão registrada.` });
      if (id) proposals += 1;
    }
  }

  if (summary.todaySpentCents > summary.caps.daily_cap_cents || summary.monthSpentCents > summary.caps.monthly_cap_cents) {
    const db = getDb();
    const userId = db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
    if (userId && !db.notifications.some((n) => n.title.startsWith("Gasto de anúncios acima do teto") && n.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10))) {
      db.notifications.unshift({
        id: uid("ntf"),
        organization_id: db.organization.id,
        user_id: userId,
        title: "Gasto de anúncios acima do teto",
        body: `Hoje ${formatBrl(summary.todaySpentCents)} (teto ${formatBrl(summary.caps.daily_cap_cents)}); no mês ${formatBrl(summary.monthSpentCents)} (teto ${formatBrl(summary.caps.monthly_cap_cents)}). Pause as campanhas.`,
        link: "/agentes/traffic-manager",
        read: false,
        created_at: new Date().toISOString(),
      });
    }
    for (const c of campaigns) if (await proposeBudgetChange({ campaign: c, action: "pausar", reason: "O gasto passou do teto diário ou mensal configurado." })) proposals += 1;
  }

  ctx.setResult({ campaigns: campaigns.length, proposals });
}

async function plan(): Promise<PlannedTask[]> {
  const cfg = await getTrafficConfig();
  const [campaigns, now] = [await agentRepo().list("ad_campaigns", { orderBy: "created_at", desc: true, limit: 50 }), new Date()];
  const out: PlannedTask[] = [];
  const pending = campaigns.filter((c) => c.status === "pendente" || c.status === "rascunho").length;
  const last = campaigns[0];
  const recently = last && now.getTime() - Date.parse(last.created_at) < PROPOSE_EVERY_DAYS * 86_400_000;
  if (pending < cfg.max_pending_campaigns && !recently && getDb().company_profile.main_services.length > 0) {
    out.push({ agent: "traffic-manager", kind: ADS_PROPOSE, payload: {}, dedupeKey: `${ADS_PROPOSE}:${dayKey()}`, title: "Propor um rascunho de campanha", detail: "Para você aprovar; ativar é outro clique, dentro dos tetos de gasto." });
  }
  if (campaigns.some((c) => c.status === "ativa")) {
    out.push({ agent: "traffic-manager", kind: ADS_REVIEW, payload: {}, dedupeKey: `${ADS_REVIEW}:${dayKey()}`, title: "Revisar o desempenho das campanhas ativas", detail: "Só propõe pausar ou ajustar; nada muda sem o seu clique." });
  }
  return out;
}

export const trafficManager: AgentDefinition = {
  id: "traffic-manager",
  name: "Gestor de Tráfego",
  description: "Propõe rascunhos de campanha e sugere pausar o que gasta sem resultado. Toda campanha nasce rascunho; ativar e aumentar orçamento exigem o seu clique, dentro dos tetos de gasto diário e mensal.",
  kinds: [ADS_PROPOSE, ADS_REVIEW],
  direct: true,
  plan,
};

export function registerTrafficHandlers() {
  registerAgentHandler(ADS_PROPOSE, propose);
  registerAgentHandler(ADS_REVIEW, review);
}
