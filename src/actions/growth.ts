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
import { getAgentMode, getSocialConfig, getTrafficConfig, isGloballyEnabled, saveSettings } from "@/services/agents/settings";
import { parseBrasiliaLocal } from "@/lib/brasilia-time";
import {
  activateCampaign,
  approveCampaignCreative,
  approveCampaignDraft,
  endCampaign,
  pauseCampaign,
  recordReport,
  regenerateCampaignCreative,
  rejectCampaignCreative,
  rejectCampaignDraft,
  setCampaignBudget,
} from "@/services/ads/campaigns";
import { approveAndPublish, approveAndSchedule, cancelSchedule, editPost, markNotPublished, reconcileUncertainPost, regeneratePostCreative, rejectPost, reopenFailedPost } from "@/services/social/posts";
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

/** "Aprovar e publicar": publica agora, este post, depois do seu clique. */
export async function approveAndPublishPost(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await approveAndPublish(String(postId), admin.id);
  refresh();
  return r.ok ? ok("Publicado no Instagram.") : fail(r.error);
}

const scheduleSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

/**
 * "Aprovar e agendar": aprova ESTE post para a data escolhida (horário de Brasília). Um post por clique,
 * nunca em lote: não existe ação que agende vários. O publicador reconfere tudo na hora de sair.
 */
export async function scheduleSocialPost(postId: string, when: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = scheduleSchema.safeParse(when);
  const at = parsed.success ? parseBrasiliaLocal(parsed.data) : null;
  if (!at) return fail("Escolha a data e a hora do agendamento.");
  const r = await approveAndSchedule(String(postId), admin.id, at);
  refresh();
  return r.ok ? ok("Agendado. Sai na hora marcada, depois de o sistema reconferir tudo.") : fail(r.error);
}

export async function cancelSocialSchedule(postId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await cancelSchedule(String(postId));
  refresh();
  return done ? ok("Agendamento cancelado: o post voltou a esperar você.") : fail("Só um post agendado pode ser desagendado (talvez já tenha saído).");
}

/** Outra composição da arte do post (a anterior é descartada). */
export async function regenerateSocialArt(postId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const r = await regeneratePostCreative(String(postId));
  refresh();
  return r.ok ? ok(r.creative.status === "falhou" ? `A arte não saiu: ${r.creative.error ?? "veja as verificações"}` : "Nova arte pronta.") : fail(r.error);
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

const socialConfigSchema = z.object({
  max_pending_posts: z.number().int().min(1).max(20),
  proposal_ttl_days: z.number().int().min(1).max(14),
  hashtags: z.array(z.string().max(40)).max(8),
  calendar_days: z.number().int().min(1).max(14).optional(),
  weekly_feed: z.number().int().min(0).max(7).optional(),
  weekly_reel: z.number().int().min(0).max(7).optional(),
  weekly_story: z.number().int().min(0).max(14).optional(),
  feed_hour: z.number().int().min(0).max(23).optional(),
  reel_hour: z.number().int().min(0).max(23).optional(),
  story_hour: z.number().int().min(0).max(23).optional(),
  late_window_hours: z.number().int().min(1).max(24).optional(),
  creative_builder: z.enum(["modelos", "claude-code"]).optional(),
  creative_budget_usd: z.number().min(0.1).max(5).optional(),
});

export async function saveSocialConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = socialConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida.");
  // Mescla com o que já está salvo: campos não enviados não voltam ao padrão.
  await saveSettings("social-media", { config: { ...normalizeSocialConfig({ ...(await getSocialConfig()), ...parsed.data }) } });
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

/** Aprovar a IMAGEM do anúncio: um clique; ativar a campanha é outro, dentro dos tetos. */
export async function approveAdCreative(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const r = await approveCampaignCreative(String(campaignId), admin.id);
  refresh();
  return r.ok ? ok("Imagem aprovada. Ativar a campanha continua sendo outro clique.") : fail(r.error);
}

export async function rejectAdCreative(campaignId: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const done = await rejectCampaignCreative(String(campaignId));
  refresh();
  return done ? ok("Imagem recusada. Peça outra composição.") : fail("Só uma imagem pendente pode ser recusada.");
}

export async function regenerateAdCreative(campaignId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const r = await regenerateCampaignCreative(String(campaignId));
  refresh();
  return r.ok ? ok(r.creative.status === "falhou" ? `A imagem não saiu: ${r.creative.error ?? "veja as verificações"}` : "Nova imagem pronta.") : fail(r.error);
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

const trafficConfigSchema = z.object({
  daily_cap_cents: z.number().int().min(0).max(10_000_000),
  monthly_cap_cents: z.number().int().min(0).max(1_000_000_000),
  max_pending_campaigns: z.number().int().min(1).max(20),
  creative_builder: z.enum(["modelos", "claude-code"]).optional(),
  creative_budget_usd: z.number().min(0.1).max(5).optional(),
});

export async function saveTrafficConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = trafficConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida.");
  await saveSettings("traffic-manager", { config: { ...normalizeTrafficConfig({ ...(await getTrafficConfig()), ...parsed.data }) } });
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
