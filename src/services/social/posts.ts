import "server-only";
import { creativeMediaUrl } from "@/lib/creative-policy";
import { canMovePost, checkCaption, checkImageUrl, checkSchedule, dueState, FORMAT_LABEL, postDigest, publishable } from "@/lib/social-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getSocialConfig } from "@/services/agents/settings";
import { approveCreative, createCreative, integrity, regenerateCreative, retireCreative, revokeCreativeApproval, type CreativeDeps } from "@/services/creatives/engine";
import { createInstagramReader, InstagramError, type InstagramReader } from "@/services/social/instagram";
import { createInstagramPublisher, type InstagramPublisher } from "@/services/social/instagram-publisher";
import type { Approval, Creative, PostFormat, SocialPost, SocialPostStatus } from "@/types/agents";

/**
 * Posts do Instagram: propor, editar, decidir, agendar e publicar.
 *
 * A regra do projeto, em código: **só duas funções publicam**, e ambas começam num clique seu:
 *  - `approveAndPublish` ("Aprovar e publicar"): a Server Action do botão a chama;
 *  - `publishDueScheduled`: publica SÓ o que você agendou com "Aprovar e agendar" (item a item, nunca em
 *    lote), na hora marcada, depois de reconferir tudo (legenda, mídia, resumo do que você aprovou, janela).
 * As propostas dos agentes passam por `proposePost` (post "pendente" + pedido de aprovação) e nada mais.
 */

const neverSay = () => getDb().company_profile.never_say;
const DAY_MS = 86_400_000;

export interface PostDeps {
  now?: () => Date;
  publisher?: InstagramPublisher | null;
  reader?: InstagramReader | null;
  /** Para gerar de novo a arte (testes injetam navegador e ffmpeg simulados). */
  creative?: CreativeDeps;
  env?: Record<string, string | undefined>;
}

async function setStatus(post: SocialPost, to: SocialPostStatus, patch: Partial<SocialPost> = {}, now: Date = new Date()): Promise<SocialPost> {
  if (!canMovePost(post.status, to)) throw new Error(`Transição inválida de post: ${post.status} → ${to}`);
  const updated = await agentRepo().update("social_posts", post.id, { ...patch, status: to, updated_at: now.toISOString() });
  return updated ?? { ...post, ...patch, status: to };
}

async function syncApproval(post: SocialPost, status: Approval["status"], userId: string | null, now: Date) {
  if (!post.approval_id) return;
  await agentRepo().update("approvals", post.approval_id, { status, decided_by: userId, decided_at: now.toISOString() });
}

/* ------------------------------------------------------------------ */
/* Mídia do post                                                       */
/* ------------------------------------------------------------------ */

export interface PostMedia {
  /** Endereço público (https) que o Instagram vai buscar; `null` = ainda não dá para publicar. */
  url: string | null;
  source: "manual" | "criativo" | null;
  /** Por que não há `url` (o que falta), em português. */
  reason: string | null;
  creative: Creative | null;
}

/**
 * A mídia que vai de fato: o endereço informado à mão, ou o do criativo (precisa existir íntegro e ter
 * hospedagem pública). Sem hospedagem (PUBLIC_BASE_URL https ou túnel) o post fica "sem hospedagem".
 */
export async function resolveMedia(post: SocialPost, env: Record<string, string | undefined> = process.env): Promise<PostMedia> {
  const manual = post.image_url?.trim();
  if (manual) {
    const bad = checkImageUrl(manual);
    return bad ? { url: null, source: "manual", reason: bad, creative: null } : { url: manual, source: "manual", reason: null, creative: null };
  }
  if (!post.creative_id) return { url: null, source: null, reason: "O post não tem mídia: gere a arte ou informe o endereço de uma imagem.", creative: null };
  const creative = await agentRepo().get("creatives", post.creative_id);
  if (!creative) return { url: null, source: "criativo", reason: "A arte deste post não existe mais.", creative: null };
  if (creative.status === "falhou") return { url: null, source: "criativo", reason: `A arte não foi gerada: ${creative.error ?? "motivo desconhecido"}`, creative };
  if (creative.status !== "pendente" && creative.status !== "aprovado") return { url: null, source: "criativo", reason: `A arte está "${creative.status}": peça outra.`, creative };
  if (creative.format !== post.format) return { url: null, source: "criativo", reason: "A arte não é do formato do post.", creative };
  const ok = integrity(creative);
  if (!ok.ok) return { url: null, source: "criativo", reason: ok.reason, creative };
  const url = creativeMediaUrl(creative, env);
  if (!url) return { url: null, source: "criativo", reason: "Sem hospedagem pública: defina PUBLIC_BASE_URL (https) ou use um túnel para o Instagram conseguir buscar a mídia.", creative };
  return { url, source: "criativo", reason: null, creative };
}

/** O que entra no resumo do que você aprovou: o resumo do arquivo da arte, ou o endereço informado. */
const mediaKey = (m: PostMedia): string => (m.source === "criativo" ? (m.creative?.content_hash ?? "") : (m.url ?? ""));

/* ------------------------------------------------------------------ */
/* Propor e editar                                                     */
/* ------------------------------------------------------------------ */

export interface ProposeInput {
  topic: string;
  caption: string;
  imageIdea: string;
  imageUrl?: string | null;
  format?: PostFormat;
  /** Quando o agente sugere publicar (calendário editorial). */
  suggestedAt?: string | null;
  /** O texto da arte (e quem a escreve). Sem isto o post fica sem arte (você informa uma imagem). */
  creative?: { headline: string; body?: string; cta?: string; builder?: Creative["builder"]; budgetUsd?: number };
}

/** Cria o post "pendente" e o pedido de aprovação, com a arte. Não publica nada: é o máximo que um agente alcança. */
export async function proposePost(input: ProposeInput, now: Date = new Date(), creativeDeps: CreativeDeps = {}): Promise<SocialPost> {
  const violation = checkCaption(input.caption, neverSay());
  if (violation) throw new Error(`Legenda reprovada: ${violation}`);
  const cfg = await getSocialConfig();
  const id = uid("spost");
  const iso = now.toISOString();
  const expires = new Date(now.getTime() + cfg.proposal_ttl_days * DAY_MS).toISOString();
  const approvalId = uid("apv");
  const format = input.format ?? "feed";
  const post: SocialPost = {
    id,
    organization_id: orgId(),
    platform: "instagram",
    topic: input.topic.slice(0, 160),
    caption: input.caption.trim(),
    format,
    creative_id: null,
    image_url: input.imageUrl ?? null,
    suggested_at: input.suggestedAt ?? null,
    scheduled_at: null,
    approved_digest: null,
    image_idea: input.imageIdea.slice(0, 300),
    status: "pendente",
    approval_id: approvalId,
    idempotency_key: `post:${id}`,
    external_id: null,
    permalink: null,
    error: null,
    uncertain: false,
    edited: false,
    approved_by: null,
    approved_at: null,
    published_at: null,
    created_at: iso,
    updated_at: iso,
    expires_at: expires,
  };
  await agentRepo().insert("social_posts", post);
  await agentRepo().insert("approvals", {
    id: approvalId,
    organization_id: orgId(),
    agent: "social-media",
    kind: "social_post",
    title: `${FORMAT_LABEL[format]} no Instagram: ${post.topic}`,
    detail: post.image_idea,
    payload: { post_id: id },
    dedupe_key: `social_post:${id}`,
    status: "pendente",
    decided_by: null,
    decided_at: null,
    task_id: null,
    created_at: iso,
    expires_at: expires,
  });
  await logAgentEvent("social-media", "info", "post.proposed", `Propôs um ${FORMAT_LABEL[format]}: ${post.topic}.`, { post_id: id, format });

  if (input.creative && !input.imageUrl) {
    const c = await createCreative({ ownerKind: "post", ownerId: id, format, headline: input.creative.headline, body: input.creative.body, cta: input.creative.cta, builder: input.creative.builder, claudeBudgetUsd: input.creative.budgetUsd }, { now: () => now, ...creativeDeps });
    post.creative_id = c.id;
    await agentRepo().update("social_posts", id, { creative_id: c.id });
  }
  return post;
}

/** Edita a legenda e/ou o endereço da mídia de um post ainda pendente. */
export async function editPost(postId: string, patch: { caption?: string; image_url?: string | null }, now: Date = new Date()): Promise<{ ok: true; post: SocialPost } | { ok: false; error: string }> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post) return { ok: false, error: "Post não encontrado." };
  if (post.status !== "pendente") return { ok: false, error: "Só um post pendente pode ser editado." };
  const next: Partial<SocialPost> = {};
  if (patch.caption !== undefined && patch.caption.trim() !== post.caption.trim()) {
    const violation = checkCaption(patch.caption, neverSay());
    if (violation) return { ok: false, error: violation };
    next.caption = patch.caption.trim();
    next.edited = true;
  }
  if (patch.image_url !== undefined) {
    const url = patch.image_url?.trim() || null;
    if (url) {
      const violation = checkImageUrl(url);
      if (violation) return { ok: false, error: violation };
    }
    next.image_url = url;
  }
  const updated = await agentRepo().update("social_posts", post.id, { ...next, updated_at: now.toISOString() });
  return { ok: true, post: updated ?? { ...post, ...next } };
}

export async function rejectPost(postId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post || post.status !== "pendente") return false;
  await setStatus(post, "recusado", {}, now);
  await syncApproval(post, "recusado", userId, now);
  await retireCreative(post.creative_id, now);
  await logAgentEvent("social-media", "info", "post.rejected", `Post recusado: ${post.topic}.`, { post_id: post.id });
  return true;
}

/** Gera a arte do post (ou outra composição, se já houver): só num post pendente. */
export async function regeneratePostCreative(postId: string, deps: PostDeps = {}): Promise<{ ok: true; creative: Creative } | { ok: false; error: string }> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post) return { ok: false, error: "Post não encontrado." };
  if (post.status !== "pendente") return { ok: false, error: "Só um post pendente pode trocar de arte." };
  const cfg = await getSocialConfig();
  const opts = { builder: cfg.creative_builder, claudeBudgetUsd: cfg.creative_budget_usd };
  const cdeps = { now: deps.now, ...deps.creative };
  const profile = getDb().company_profile;
  let fresh: Creative | null = null;
  if (post.creative_id) fresh = await regenerateCreative(post.creative_id, cdeps, opts);
  if (!fresh) fresh = await createCreative({ ownerKind: "post", ownerId: post.id, format: post.format, headline: post.topic, body: profile.what_we_sell, cta: "Chame no direct", ...opts }, cdeps);
  await agentRepo().update("social_posts", post.id, { creative_id: fresh.id, image_url: null, updated_at: (deps.now?.() ?? new Date()).toISOString() });
  return { ok: true, creative: fresh };
}

/* ------------------------------------------------------------------ */
/* Publicar                                                            */
/* ------------------------------------------------------------------ */

export type PublishOutcome = { ok: true; post: SocialPost } | { ok: false; error: string; post?: SocialPost };

/** A chamada à API e o desfecho (publicado, falha, incerto). O post já está em "publicando". */
async function executePublish(publishing: SocialPost, mediaUrl: string, publisher: InstagramPublisher, now: Date): Promise<PublishOutcome> {
  try {
    const q = await publisher.quota();
    if (q && q.used >= q.total) throw new InstagramError("RATE_LIMITED", `O Instagram já recebeu ${q.used} de ${q.total} publicações pela API nas últimas 24 h: tente mais tarde.`);
    const res = await publisher.publishMedia({ format: publishing.format, mediaUrl, caption: publishing.caption, idempotencyKey: publishing.idempotency_key });
    const done = await setStatus(publishing, "publicado", { external_id: res.id, permalink: res.permalink, published_at: new Date().toISOString(), error: null, uncertain: false }, now);
    await logAgentEvent("social-media", "info", "post.published", `${FORMAT_LABEL[publishing.format]} publicado no Instagram: ${publishing.topic}.`, { post_id: publishing.id, external_id: res.id });
    return { ok: true, post: done };
  } catch (err) {
    const e = err instanceof InstagramError ? err : new InstagramError("TEMPORARY", err instanceof Error ? err.message : "erro desconhecido");
    const failed = await setStatus(publishing, "falhou", { error: e.message.slice(0, 300), uncertain: e.uncertain }, now);
    await logAgentEvent(
      "social-media",
      e.uncertain ? "warn" : "error",
      e.uncertain ? "post.uncertain" : "post.failed",
      e.uncertain ? `A publicação de "${publishing.topic}" ficou sem confirmação: pode ter saído. Confira no Instagram antes de agir.` : `Falha ao publicar "${publishing.topic}": ${e.message}`,
      { post_id: publishing.id }
    );
    notify(e.uncertain ? "Publicação sem confirmação" : "Não foi possível publicar o post", e.uncertain ? `Confira no Instagram se "${publishing.topic}" saiu.` : e.message.slice(0, 120));
    return { ok: false, error: e.uncertain ? "Sem confirmação do Instagram: o post pode ter saído. Confira antes de tentar de novo." : e.message, post: failed };
  }
}

/**
 * "Aprovar e publicar": publica AGORA. Aprova, reivindica o post (status "publicando", de modo que um
 * segundo clique é recusado) e só então chama a API. Qualquer falha antes da chamada deixa o post como
 * estava; falha depois dela vira "falhou" — e, se não houve confirmação, "incerta": nunca se repete sozinha.
 */
export async function approveAndPublish(postId: string, userId: string, deps: PostDeps = {}): Promise<PublishOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = agentRepo();
  const post = await repo.get("social_posts", postId);
  if (!post) return { ok: false, error: "Post não encontrado." };

  if (post.status === "pendente" && post.expires_at <= now.toISOString()) {
    await setStatus(post, "expirado", {}, now);
    await syncApproval(post, "expirado", null, now);
    await retireCreative(post.creative_id, now);
    return { ok: false, error: "A proposta expirou. O agente fará uma nova." };
  }
  const media = await resolveMedia(post, deps.env);
  const check = publishable(post, neverSay(), now, media.url);
  if (!check.ok) return { ok: false, error: media.url ? check.reason : (media.reason ?? check.reason) };

  const publisher = deps.publisher === undefined ? createInstagramPublisher() : deps.publisher;
  if (!publisher) return { ok: false, error: "O Instagram não está configurado (INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ID)." };

  // O clique aprova e, no mesmo passo, reivindica de forma ATÔMICA: dois cliques seguidos (ou duas
  // abas) não publicam duas vezes — quem não leva o post pendente recebe a recusa.
  const approved = await repo.claimStatus("social_posts", post.id, "pendente", { status: "aprovado", approved_by: userId, approved_at: now.toISOString(), updated_at: now.toISOString() });
  if (!approved) return { ok: false, error: "Este post já foi decidido (talvez em outra aba)." };
  await syncApproval(post, "aprovado", userId, now);
  if (media.source === "criativo" && media.creative) {
    // A mídia só é servida de fora depois do clique; fica no ar até o Instagram buscá-la.
    const c = await approveCreative(media.creative.id, userId, { keepUntil: new Date(now.getTime() + 3 * DAY_MS), now });
    if (!c.ok) {
      const failed = await setStatus(approved, "falhou", { error: c.error.slice(0, 300), uncertain: false }, now);
      return { ok: false, error: c.error, post: failed };
    }
  }
  const publishing = await setStatus(approved, "publicando", {}, now);
  return executePublish(publishing, media.url!, publisher, now);
}

/* ------------------------------------------------------------------ */
/* Agendar                                                             */
/* ------------------------------------------------------------------ */

export type ScheduleOutcome = { ok: true; post: SocialPost } | { ok: false; error: string };

/**
 * "Aprovar e agendar": você aprova ESTE post para ESTA data. Nada é publicado agora; o publicador agendado
 * (`publishDueScheduled`) o faz na hora marcada, depois de reconferir tudo. Um post por clique, nunca em lote.
 */
export async function approveAndSchedule(postId: string, userId: string, scheduledAt: Date, deps: PostDeps = {}): Promise<ScheduleOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = agentRepo();
  const when = checkSchedule(scheduledAt, now);
  if (when) return { ok: false, error: when };
  const post = await repo.get("social_posts", postId);
  if (!post) return { ok: false, error: "Post não encontrado." };
  if (post.status === "pendente" && post.expires_at <= now.toISOString()) {
    await setStatus(post, "expirado", {}, now);
    await syncApproval(post, "expirado", null, now);
    await retireCreative(post.creative_id, now);
    return { ok: false, error: "A proposta expirou. O agente fará uma nova." };
  }
  const media = await resolveMedia(post, deps.env);
  const check = publishable(post, neverSay(), now, media.url);
  if (!check.ok) return { ok: false, error: media.url ? check.reason : (media.reason ?? check.reason) };
  const iso = scheduledAt.toISOString();
  const digest = postDigest({ format: post.format, caption: post.caption, media: mediaKey(media), scheduledAt: iso });
  const scheduled = await repo.claimStatus("social_posts", post.id, "pendente", { status: "agendado", scheduled_at: iso, approved_by: userId, approved_at: now.toISOString(), approved_digest: digest, updated_at: now.toISOString() });
  if (!scheduled) return { ok: false, error: "Este post já foi decidido (talvez em outra aba)." };
  await syncApproval(post, "aprovado", userId, now);
  if (media.source === "criativo" && media.creative) {
    const cfg = await getSocialConfig();
    const c = await approveCreative(media.creative.id, userId, { keepUntil: new Date(scheduledAt.getTime() + cfg.late_window_hours * 3_600_000 + 2 * DAY_MS), now });
    if (!c.ok) {
      // Nada foi agendado: volta a pendente para você decidir de novo.
      await repo.claimStatus("social_posts", post.id, "agendado", { status: "pendente", scheduled_at: null, approved_by: null, approved_at: null, approved_digest: null, updated_at: now.toISOString() });
      await syncApproval(post, "pendente", null, now);
      return { ok: false, error: c.error };
    }
  }
  await logAgentEvent("social-media", "info", "post.scheduled", `${FORMAT_LABEL[post.format]} agendado para ${iso}: ${post.topic}.`, { post_id: post.id, scheduled_at: iso });
  return { ok: true, post: scheduled };
}

/** Cancela o agendamento: o post volta a "pendente" e a aprovação (do post e da arte) é revogada. */
export async function cancelSchedule(postId: string, now: Date = new Date()): Promise<boolean> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post || post.status !== "agendado") return false;
  const cfg = await getSocialConfig();
  const back = await agentRepo().claimStatus("social_posts", post.id, "agendado", {
    status: "pendente",
    scheduled_at: null,
    approved_by: null,
    approved_at: null,
    approved_digest: null,
    expires_at: new Date(now.getTime() + cfg.proposal_ttl_days * DAY_MS).toISOString(),
    updated_at: now.toISOString(),
  });
  if (!back) return false; // o publicador chegou primeiro
  if (post.approval_id) await agentRepo().update("approvals", post.approval_id, { status: "pendente", decided_by: null, decided_at: null, expires_at: back.expires_at });
  await revokeCreativeApproval(post.creative_id, now);
  await logAgentEvent("social-media", "info", "post.unscheduled", `Agendamento cancelado: ${post.topic}.`, { post_id: post.id });
  return true;
}

/** Reconfere TUDO o que você aprovou antes de o publicador agendado sair. */
export async function reconfirm(post: SocialPost, deps: PostDeps = {}): Promise<{ ok: true; media: PostMedia } | { ok: false; reason: string }> {
  if (post.status !== "agendado" || !post.scheduled_at || !post.approved_by || !post.approved_at || !post.approved_digest) return { ok: false, reason: "O post não está aprovado para agendamento." };
  const caption = checkCaption(post.caption, neverSay());
  if (caption) return { ok: false, reason: `A legenda não passa mais nas barreiras: ${caption}` };
  const media = await resolveMedia(post, deps.env);
  if (!media.url) return { ok: false, reason: media.reason ?? "Sem mídia." };
  if (media.source === "criativo") {
    const c = media.creative!;
    if (c.status !== "aprovado") return { ok: false, reason: "A arte deixou de estar aprovada." };
    if (c.expires_at <= (deps.now?.() ?? new Date()).toISOString()) return { ok: false, reason: "A arte venceu antes de a hora chegar." };
  }
  const digest = postDigest({ format: post.format, caption: post.caption, media: mediaKey(media), scheduledAt: post.scheduled_at });
  if (digest !== post.approved_digest) return { ok: false, reason: "O post mudou depois da sua aprovação (legenda, arte ou data): nada foi publicado." };
  return { ok: true, media };
}

async function failScheduled(post: SocialPost, reason: string, now: Date): Promise<void> {
  await setStatus(post, "falhou", { error: reason.slice(0, 300), uncertain: false }, now);
  await logAgentEvent("social-media", "warn", "post.schedule_failed", `Agendamento não executado ("${post.topic}"): ${reason}`, { post_id: post.id });
  notify("Post agendado não saiu", `${post.topic}: ${reason.slice(0, 110)}`);
}

export interface DueReport {
  published: number;
  failed: number;
  late: number;
  waiting: number;
}

/**
 * Publica o que você agendou e já chegou a hora. Para cada item: passou da janela → avisa em vez de
 * sair fora de hora; reconferência reprovada → avisa; senão reivindica (agendado → publicando, atômico)
 * e publica. O runner só chama isto com o agente de Mídias Sociais liberado (interruptor geral e modo).
 */
export async function publishDueScheduled(deps: PostDeps = {}): Promise<DueReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report: DueReport = { published: 0, failed: 0, late: 0, waiting: 0 };
  const cfg = await getSocialConfig();
  const scheduled = (await agentRepo().list("social_posts", { where: { status: "agendado" } })).sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));

  for (const post of scheduled) {
    if (!post.scheduled_at) continue;
    const state = dueState(post.scheduled_at, now, cfg.late_window_hours);
    if (state === "wait") {
      report.waiting++;
      continue;
    }
    if (state === "late") {
      await failScheduled(post, `Passou da janela de ${cfg.late_window_hours} h depois do horário agendado: não publico fora de hora. Reagende.`, now);
      report.late++;
      continue;
    }
    const verdict = await reconfirm(post, deps);
    if (!verdict.ok) {
      await failScheduled(post, verdict.reason, now);
      report.failed++;
      continue;
    }
    const publisher = deps.publisher === undefined ? createInstagramPublisher() : deps.publisher;
    if (!publisher) {
      await failScheduled(post, "O Instagram não está configurado (INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ID).", now);
      report.failed++;
      continue;
    }
    const publishing = await agentRepo().claimStatus("social_posts", post.id, "agendado", { status: "publicando", updated_at: now.toISOString() });
    if (!publishing) continue; // cancelado (ou publicado por outro) no meio
    const out = await executePublish(publishing, verdict.media.url!, publisher, now);
    if (out.ok) report.published++;
    else report.failed++;
  }
  return report;
}

function notify(title: string, body: string) {
  const db = getDb();
  const userId = db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (!userId) return;
  db.notifications.unshift({ id: uid("ntf"), organization_id: db.organization.id, user_id: userId, title, body, link: "/agentes/social-media", read: false, created_at: new Date().toISOString() });
  saveDb();
}

/** Falha SEM incerteza volta a "pendente", para um novo clique (nunca publica sozinha). */
export async function reopenFailedPost(postId: string, now: Date = new Date()): Promise<boolean> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post || post.status !== "falhou" || post.uncertain) return false;
  const reopened = await setStatus(post, "pendente", { error: null, scheduled_at: null, approved_by: null, approved_at: null, approved_digest: null, expires_at: new Date(now.getTime() + 2 * DAY_MS).toISOString() }, now);
  if (reopened.approval_id) await agentRepo().update("approvals", reopened.approval_id, { status: "pendente", decided_by: null, decided_at: null, expires_at: reopened.expires_at });
  await revokeCreativeApproval(post.creative_id, now);
  return true;
}

/**
 * Publicação incerta: procura o post nos últimos publicados. Achou (mesma legenda, depois
 * da aprovação) → "publicado"; não achou → continua incerta, com o motivo.
 */
export async function reconcileUncertainPost(postId: string, deps: PostDeps = {}): Promise<{ ok: boolean; message: string }> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post || post.status !== "falhou" || !post.uncertain) return { ok: false, message: "Este post não está aguardando conferência." };
  const reader = deps.reader === undefined ? createInstagramReader() : deps.reader;
  if (!reader) return { ok: false, message: "O Instagram não está configurado para conferir." };
  try {
    const media = await reader.recentMedia(25);
    // Stories não têm legenda pela API e somem em 24 h: a conferência por legenda só vale para Feed e Reels.
    if (post.format === "story") return { ok: false, message: "Stories não têm legenda para conferir: veja no Instagram se saiu e, se não saiu, marque como não publicado." };
    const hit = media.find((m) => m.caption.trim() === post.caption.trim() && (!m.timestamp || !post.approved_at || m.timestamp >= post.approved_at));
    if (!hit) return { ok: false, message: "Não encontrei este post entre os últimos publicados. Confira no Instagram; se não saiu, marque como não publicado." };
    await setStatus(post, "publicado", { external_id: hit.id, permalink: hit.permalink, published_at: hit.timestamp ?? new Date().toISOString(), error: null, uncertain: false });
    return { ok: true, message: "O post está no Instagram: marcado como publicado." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Não foi possível conferir agora." };
  }
}

/** Você conferiu e o post NÃO saiu: deixa de ser incerto (e pode ser reaberto para um novo clique). */
export async function markNotPublished(postId: string): Promise<boolean> {
  const post = await agentRepo().get("social_posts", postId);
  if (!post || post.status !== "falhou" || !post.uncertain) return false;
  await agentRepo().update("social_posts", post.id, { uncertain: false, error: "Conferido: não foi publicado.", updated_at: new Date().toISOString() });
  return true;
}

/** Propostas sem decisão que passaram do prazo viram "expirado" (e a arte vai embora junto). */
export async function expireStalePosts(now: Date = new Date()): Promise<number> {
  const stale = (await agentRepo().list("social_posts", { where: { status: "pendente" } })).filter((p) => p.expires_at <= now.toISOString());
  for (const p of stale) {
    await setStatus(p, "expirado", {}, now);
    await syncApproval(p, "expirado", null, now);
    await retireCreative(p.creative_id, now);
  }
  return stale.length;
}

/** Posts presos em "publicando" (o processo caiu no meio) viram falha incerta: não se sabe se saiu. */
export async function reconcileStuckPublishing(now: Date = new Date(), olderThanMs = 10 * 60_000): Promise<number> {
  const stuck = (await agentRepo().list("social_posts", { where: { status: "publicando" } })).filter((p) => now.getTime() - Date.parse(p.updated_at) > olderThanMs);
  for (const p of stuck) await setStatus(p, "falhou", { error: "Publicação interrompida sem desfecho conhecido.", uncertain: true }, now);
  return stuck.length;
}

/** O que o runner faz por conta própria enquanto o agente de Mídias Sociais está liberado. */
export async function runSocialMaintenance(deps: PostDeps = {}): Promise<{ due: DueReport; expired: number; stuck: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const stuck = await reconcileStuckPublishing(now);
  const expired = await expireStalePosts(now);
  const due = await publishDueScheduled(deps);
  return { due, expired, stuck };
}
