import "server-only";
import { AGENT_CAMPAIGN_PREFIX } from "@/agents/prospector/agent";
import type { PresenceConfig } from "@/agents/config";
import { getDb, saveDb } from "@/lib/store";
import { logAgentEvent } from "@/services/agents/log";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getPresenceConfig } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { emitEvent } from "@/services/events";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import { confidenceOf, gatherSources, headlineProblem, isSyntheticLead, summaryOf, validateDossier, type GatherResult, type PageFetcher } from "@/services/presence/gather";
import { publicPageFetcher } from "@/services/presence/fetch";
import { captureWithBrowser, findBrowser, isVisualAvailable, mergeVisual, reviewVisually, type CaptureFn, type VisionCall } from "@/services/presence/visual";
import type { Lead } from "@/types";
import type { LeadDossier } from "@/types/agents";

/**
 * Montagem do dossiê de um lead (Agente 3).
 *
 * Só lê conteúdo público e só escreve em dois lugares: o próprio dossiê e, com
 * evidência registrada no histórico do lead, a qualidade do site e os contatos
 * que o lead ainda não tinha. Nada é enviado a ninguém.
 */

export const DOSSIER_BUILD = "dossier.build";
const DAY_MS = 86_400_000;

export interface BuildDeps {
  fetchPage?: PageFetcher;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  capture?: CaptureFn;
  vision?: VisionCall;
}

/** Junta o que foi coletado no registro do dossiê (puro, sem efeitos). */
export function assembleDossier(lead: Lead, gathered: GatherResult, cfg: Pick<PresenceConfig, "refresh_days">, now: Date): LeadDossier {
  const synthetic = isSyntheticLead(lead);
  const headline = gathered.findings.length > 0 ? headlineProblem(gathered.findings) : null;
  const attemptedBad = gathered.sources.some((s) => s.status === "bloqueada" || s.status === "parcial");
  const iso = now.toISOString();
  return {
    id: lead.id,
    organization_id: orgId(),
    lead_id: lead.id,
    status: attemptedBad || synthetic ? "parcial" : "concluido",
    confidence: confidenceOf(gathered.sources, gathered.findings, synthetic),
    sources: gathered.sources,
    findings: gathered.findings,
    assessment: gathered.assessment,
    headline_problem: headline,
    summary: synthetic ? "Lead de demonstração: nenhuma fonte externa foi consultada." : summaryOf(gathered.sources, gathered.findings, headline),
    website_quality_before: lead.website_quality,
    website_quality_after: lead.website_quality,
    created_at: iso,
    updated_at: iso,
    valid_until: new Date(now.getTime() + cfg.refresh_days * DAY_MS).toISOString(),
  };
}

export async function getDossier(leadId: string): Promise<LeadDossier | null> {
  return agentRepo().get("lead_dossiers", leadId);
}

/** Dossiê que ainda vale (existe e não passou da validade). */
export async function getValidDossier(leadId: string, now: Date = new Date()): Promise<LeadDossier | null> {
  const d = await getDossier(leadId);
  return d && d.valid_until > now.toISOString() ? d : null;
}

/** Atualiza o lead com o que o dossiê comprovou, sempre deixando o rastro no histórico. */
function applyToLead(lead: Lead, dossier: LeadDossier, gathered: GatherResult): void {
  const now = new Date().toISOString();
  const changes: string[] = [];

  const verdict = gathered.siteVerdict && gathered.assessment ? gathered.assessment : null;
  if (verdict && lead.website) {
    const before = lead.website_quality;
    if (before !== verdict.label) {
      lead.website_quality = verdict.label;
      dossier.website_quality_after = verdict.label;
      changes.push(`qualidade do site: ${before} → ${verdict.label} (nota ${verdict.total}/100; ${verdict.reasons[0] ?? "sem problemas medidos"})`);
    }
  }

  // Contatos que o site publica e o cadastro não tinha.
  const facts = gathered.facts;
  if (facts) {
    if (!lead.instagram && facts.links.instagram) {
      lead.instagram = facts.links.instagram;
      lead.instagram_active = true;
      changes.push(`Instagram ${facts.links.instagram} (publicado no site)`);
    }
    if (!lead.facebook && facts.links.facebook) {
      lead.facebook = facts.links.facebook;
      changes.push("Facebook (publicado no site)");
    }
    if (!lead.whatsapp && facts.whatsapp) {
      lead.whatsapp = facts.whatsapp;
      lead.has_whatsapp = true;
      changes.push("WhatsApp (publicado no site)");
    }
    if (!lead.email && facts.email) {
      lead.email = facts.email;
      changes.push("e-mail da empresa (publicado no site)");
    }
  }

  if (changes.length > 0) {
    lead.updated_at = now;
    logActivity(lead.id, "nota_adicionada", `Dossiê atualizou o cadastro com evidência pública: ${changes.join("; ")}.`, null);
  }
}

export async function buildDossierForLead(leadId: string, deps: BuildDeps = {}): Promise<LeadDossier> {
  await ensureLeadsLoaded();
  const lead = getDb().leads.find((l) => l.id === leadId);
  if (!lead) throw new PermanentTaskError("Lead não encontrado.");
  const cfg = await getPresenceConfig();
  const now = deps.now ?? new Date();

  const gathered = await gatherSources(lead, { fetchPage: deps.fetchPage ?? publicPageFetcher, now, delayMs: cfg.fetch_delay_ms, sleep: deps.sleep });

  // Avaliação visual: só se ligada, com o site lido por inteiro e navegador + modelo disponíveis.
  if (cfg.visual && gathered.siteVerdict && gathered.facts && gathered.assessment && gathered.assessment.rubric.length > 0) {
    const capture = deps.capture ?? (isVisualAvailable().ok ? captureWithBrowser(findBrowser()!) : null);
    if (capture) {
      const visual = await reviewVisually(gathered.facts.url, { capture, vision: deps.vision });
      if (visual) gathered.assessment = mergeVisual(gathered.assessment, visual);
    }
  }

  const dossier = assembleDossier(lead, gathered, cfg, now);
  const problems = validateDossier(dossier);
  // Um dossiê que quebra a regra de evidência não é gravado: é defeito do código, não do lead.
  if (problems.length > 0) throw new PermanentTaskError(`Dossiê reprovado na checagem de evidências: ${problems.slice(0, 3).join("; ")}`);

  applyToLead(lead, dossier, gathered);
  await agentRepo().upsert("lead_dossiers", dossier);
  saveDb();
  emitEvent("lead.dossier_ready", lead, { payload: { confidence: dossier.confidence, headline: dossier.headline_problem } });
  saveDb();
  await logAgentEvent(
    "presence",
    dossier.status === "parcial" ? "warn" : "info",
    "dossier.ready",
    `Dossiê de ${lead.company_name}: ${dossier.summary}`,
    { lead_id: lead.id, confidence: dossier.confidence }
  );
  return dossier;
}

async function build(ctx: AgentTaskContext): Promise<void> {
  const payload = ctx.task.payload as { lead_id?: string };
  if (!payload.lead_id) throw new PermanentTaskError("Tarefa sem lead.");
  const dossier = await buildDossierForLead(payload.lead_id);
  await ctx.spend("dossiers", 1, payload.lead_id);
  ctx.setResult({
    lead_id: payload.lead_id,
    status: dossier.status,
    confidence: dossier.confidence,
    findings: dossier.findings.length,
    sources: Object.fromEntries(dossier.sources.map((s) => [s.key, s.status])),
    website_quality: `${dossier.website_quality_before} → ${dossier.website_quality_after}`,
  });
}

export function registerDossierHandlers() {
  registerAgentHandler(DOSSIER_BUILD, build);
}

/** Leads criados pelos agentes (campanhas "AgentOS · …"). */
export function agentCampaignIdSet(): Set<string> {
  return new Set(getDb().campaigns.filter((c) => c.name.startsWith(AGENT_CAMPAIGN_PREFIX)).map((c) => c.id));
}

/** Quem precisa de dossiê agora: sem dossiê válido, do maior score ao menor. */
export async function dossierCandidates(cfg: PresenceConfig, limit: number, now: Date = new Date()): Promise<Lead[]> {
  await ensureLeadsLoaded();
  const campaigns = agentCampaignIdSet();
  const existing = await agentRepo().list("lead_dossiers");
  const valid = new Set(existing.filter((d) => d.valid_until > now.toISOString()).map((d) => d.lead_id));
  return getDb()
    .leads.filter(
      (l) =>
        !l.archived &&
        l.status !== "perdido" &&
        l.status !== "fechado" &&
        (l.lead_score ?? 0) >= cfg.min_lead_score &&
        (!cfg.only_agent_leads || (l.campaign_id !== null && campaigns.has(l.campaign_id))) &&
        !valid.has(l.id)
    )
    .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
    .slice(0, limit);
}
