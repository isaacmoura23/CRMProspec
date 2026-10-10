"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { normalizeSocialConfig, normalizeTrafficConfig } from "@/agents/config";
import { ADS_PROPOSE } from "@/agents/traffic/agent";
import { SOCIAL_PROPOSE } from "@/agents/social/agent";
import { getAdminUser, getWriterUser } from "@/lib/auth";
import { ADMIN_DENIED, WRITE_DENIED } from "@/lib/permissions";
import { dayKey, logAgentEvent } from "@/services/agents/log";
import { enqueueAgentTask } from "@/services/agents/queue";
import { getAgentMode, isGloballyEnabled, saveSettings } from "@/services/agents/settings";
import { activateCampaign, approveCampaignDraft, endCampaign, pauseCampaign, recordReport, rejectCampaignDraft, setCampaignBudget } from "@/services/ads/campaigns";
import { approveAndPublish, editPost, markNotPublished, reconcileUncertainPost, rejectPost, reopenFailedPost } from "@/services/social/posts";
import type { AgentId } from "@/types/agents";

/**
 * Ações de Mídias Sociais e Gestor de Tráfego.
 *
 * É AQUI que mora o clique: publicar no Instagram, aprovar e ativar campanha,
 * mexer em orçamento. Cada uma exige owner ou admin e roda no servidor, e as de
 * dinheiro passam pelos tetos de gasto (em `services/ads/campaigns.ts`). Os agentes
 * não chamam nenhuma delas.
 */

type ActionResult = { ok: true; message?: string } | { ok: false; error: string };
const fail = (error: string): ActionResult => ({ ok: false, error });
const ok = (message?: string): ActionResult => ({ ok: true, message });

function refresh() {
  revalidatePath("/agentes", "layout");
}

/* ------------------------------ Instagram ------------------------------ */

/** "Aprovar e publicar": a única passagem que publica. */
export async function approveAndPublishPost(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await approveAndPublish(String(postId), admin.id);
  refresh();
  return r.ok ? ok("Post publicado no Instagram.") : fail(r.error);
}

const editSchema = z.object({ caption: z.string().max(5000).optional(), image_url: z.string().max(1000).nullable().optional() });

export async function editSocialPost(postId: string, input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return fail("Dados inválidos.");
  const r = await editPost(String(postId), parsed.data);
  refresh();
  return r.ok ? ok("Alterações salvas.") : fail(r.error);
}

export async function rejectSocialPost(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await rejectPost(String(postId), admin.id);
  refresh();
  return done ? ok("Proposta recusada.") : fail("Só uma proposta pendente pode ser recusada.");
}

export async function reopenSocialPost(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await reopenFailedPost(String(postId));
  refresh();
  return done ? ok("Post reaberto: confira e clique em “Aprovar e publicar” de novo.") : fail("Só uma falha sem incerteza pode ser reaberta.");
}

export async function reconcileSocialPost(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await reconcileUncertainPost(String(postId));
  refresh();
  return r.ok ? ok(r.message) : fail(r.message);
}

export async function markSocialPostNotPublished(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await markNotPublished(String(postId));
  refresh();
  return done ? ok("Marcado como não publicado.") : fail("Este post não está aguardando conferência.");
}

const socialConfigSchema = z.object({ max_pending_posts: z.number().int().min(1).max(10), proposal_ttl_days: z.number().int().min(1).max(14), hashtags: z.array(z.string().max(40)).max(8) });

export async function saveSocialConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = socialConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida.");
  await saveSettings("social-media", { config: { ...normalizeSocialConfig(parsed.data) } });
  await logAgentEvent("social-media", "info", "agent.config", `${admin.name} atualizou a configuração de Mídias Sociais.`);
  refresh();
  return ok("Configuração salva.");
}

/* -------------------------------- Anúncios -------------------------------- */

export async function approveAdCampaign(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await approveCampaignDraft(String(campaignId), admin.id);
  refresh();
  return r.ok ? ok("Rascunho aprovado. Ainda não gasta nada: ativar é outro clique.") : fail(r.error);
}

export async function rejectAdCampaign(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await rejectCampaignDraft(String(campaignId), admin.id);
  refresh();
  return done ? ok("Rascunho recusado.") : fail("Só um rascunho pendente pode ser recusado.");
}

/** Ativar: começa a gastar. Confere os tetos de gasto diário e mensal. */
export async function activateAdCampaign(campaignId: string, externalId?: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await activateCampaign(String(campaignId), admin.id, { externalId: externalId?.trim() ? externalId.trim().slice(0, 80) : null });
  refresh();
  return r.ok ? ok("Campanha ativada, dentro dos tetos de gasto.") : fail(r.error);
}

export async function pauseAdCampaign(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await pauseCampaign(String(campaignId), admin.id);
  refresh();
  return r.ok ? ok("Campanha pausada.") : fail(r.error);
}

export async function endAdCampaign(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await endCampaign(String(campaignId));
  refresh();
  return r.ok ? ok("Campanha encerrada.") : fail(r.error);
}

export async function setAdCampaignBudget(campaignId: string, dailyCents: number): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await setCampaignBudget(String(campaignId), Math.round(Number(dailyCents)), admin.id);
  refresh();
  return r.ok ? ok("Orçamento diário atualizado.") : fail(r.error);
}

const reportSchema = z.object({
  campaign_id: z.string().min(3).max(60),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  impressions: z.number().int().min(0).max(1_000_000_000),
  clicks: z.number().int().min(0).max(1_000_000_000),
  spend_cents: z.number().int().min(0).max(1_000_000_000),
  conversions: z.number().int().min(0).max(1_000_000),
});

export async function recordAdReport(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("Dados do relatório inválidos.");
  try {
    await recordReport({ ...parsed.data, source: "manual" });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Não foi possível gravar o relatório.");
  }
  refresh();
  return ok("Relatório do dia gravado.");
}

const trafficConfigSchema = z.object({ daily_cap_cents: z.number().int().min(0).max(10_000_000), monthly_cap_cents: z.number().int().min(0).max(1_000_000_000), max_pending_campaigns: z.number().int().min(1).max(20) });

export async function saveTrafficConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = trafficConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida.");
  await saveSettings("traffic-manager", { config: { ...normalizeTrafficConfig(parsed.data) } });
  await logAgentEvent("traffic-manager", "info", "agent.config", `${admin.name} atualizou os tetos de gasto: diário e mensal.`);
  refresh();
  return ok("Tetos de gasto salvos.");
}

/* ------------------------------ Propor agora ------------------------------ */

async function proposeNow(agent: AgentId, kind: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  if (!(await isGloballyEnabled())) return fail("Os agentes estão desligados. Ligue-os no interruptor geral.");
  if ((await getAgentMode(agent)) === "pausado") return fail("Este agente está pausado. Mude o modo para pedir uma proposta.");
  const { created } = await enqueueAgentTask({ agent, kind, dedupeKey: `manual:${kind}:${dayKey()}`, createdBy: user.id });
  refresh();
  return ok(created ? "Proposta na fila. Aparece em instantes." : "Já existe uma proposta na fila.");
}

export async function proposePostNow(): Promise<ActionResult> {
  return proposeNow("social-media", SOCIAL_PROPOSE);
}

export async function proposeCampaignNow(): Promise<ActionResult> {
  return proposeNow("traffic-manager", ADS_PROPOSE);
}
