import "server-only";
import { canMovePost, checkCaption, checkImageUrl, publishable } from "@/lib/social-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getSocialConfig } from "@/services/agents/settings";
import { createInstagramReader, InstagramError, type InstagramReader } from "@/services/social/instagram";
import { createInstagramPublisher, type InstagramPublisher } from "@/services/social/instagram-publisher";
import type { Approval, SocialPost, SocialPostStatus } from "@/types/agents";

/**
 * Posts do Instagram: propor, editar, decidir e publicar.
 *
 * A regra do projeto, em código: **a única função que publica é `approveAndPublish`**,
 * e só a Server Action do botão a chama. As propostas dos agentes passam por
 * `proposePost` (que cria o post "pendente" e o pedido de aprovação) e nada mais.
 */

const neverSay = () => getDb().company_profile.never_say;

export interface PostDeps {
  now?: () => Date;
  publisher?: InstagramPublisher | null;
  reader?: InstagramReader | null;
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

/** Cria o post "pendente" e o pedido de aprovação. Não publica nada: é o máximo que um agente alcança. */
export async function proposePost(input: { topic: string; caption: string; imageIdea: string; imageUrl?: string | null }, now: Date = new Date()): Promise<SocialPost> {
  const violation = checkCaption(input.caption, neverSay());
  if (violation) throw new Error(`Legenda reprovada: ${violation}`);
  const cfg = await getSocialConfig();
  const id = uid("spost");
  const iso = now.toISOString();
  const expires = new Date(now.getTime() + cfg.proposal_ttl_days * 86_400_000).toISOString();
  const approvalId = uid("apv");
  const post: SocialPost = {
    id,
    organization_id: orgId(),
    platform: "instagram",
    topic: input.topic.slice(0, 160),
    caption: input.caption.trim(),
    image_url: input.imageUrl ?? null,
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
    title: `Post no Instagram: ${post.topic}`,
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
  await logAgentEvent("social-media", "info", "post.proposed", `Propôs um post: ${post.topic}.`, { post_id: id });
  return post;
}

/** Edita a legenda e/ou a imagem de um post ainda pendente. */
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
  await logAgentEvent("social-media", "info", "post.rejected", `Post recusado: ${post.topic}.`, { post_id: post.id });
  return true;
}

export type PublishOutcome = { ok: true; post: SocialPost } | { ok: false; error: string; post?: SocialPost };

/**
 * "Aprovar e publicar": a ÚNICA passagem que publica. Aprova, reivindica o post
 * (status "publicando", de modo que um segundo clique é recusado) e só então chama a
 * API. Qualquer falha antes da chamada deixa o post como estava; falha depois dela vira
 * "falhou" — e, se não houve confirmação, "incerta": nunca se repete sozinha.
 */
export async function approveAndPublish(postId: string, userId: string, deps: PostDeps = {}): Promise<PublishOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = agentRepo();
  const post = await repo.get("social_posts", postId);
  if (!post) return { ok: false, error: "Post não encontrado." };

  if (post.status === "pendente" && post.expires_at <= now.toISOString()) {
    await setStatus(post, "expirado", {}, now);
    await syncApproval(post, "expirado", null, now);
    return { ok: false, error: "A proposta expirou. O agente fará uma nova." };
  }
  const check = publishable(post, neverSay(), now);
  if (!check.ok) return { ok: false, error: check.reason };

  const publisher = deps.publisher === undefined ? createInstagramPublisher() : deps.publisher;
  if (!publisher) return { ok: false, error: "O Instagram não está configurado (INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ID)." };

  // O clique aprova e, no mesmo passo, reivindica de forma ATÔMICA: dois cliques seguidos (ou duas
  // abas) não publicam duas vezes — quem não leva o post pendente recebe a recusa.
  const approved = await repo.claimStatus("social_posts", post.id, "pendente", { status: "aprovado", approved_by: userId, approved_at: now.toISOString(), updated_at: now.toISOString() });
  if (!approved) return { ok: false, error: "Este post já foi decidido (talvez em outra aba)." };
  await syncApproval(post, "aprovado", userId, now);
  const publishing = await setStatus(approved, "publicando", {}, now);

  try {
    const res = await publisher.publishImage({ imageUrl: post.image_url!, caption: post.caption, idempotencyKey: post.idempotency_key });
    const done = await setStatus(publishing, "publicado", { external_id: res.id, permalink: res.permalink, published_at: new Date().toISOString(), error: null, uncertain: false }, now);
    await logAgentEvent("social-media", "info", "post.published", `Post publicado no Instagram: ${post.topic}.`, { post_id: post.id, external_id: res.id });
    return { ok: true, post: done };
  } catch (err) {
    const e = err instanceof InstagramError ? err : new InstagramError("TEMPORARY", err instanceof Error ? err.message : "erro desconhecido");
    const failed = await setStatus(publishing, "falhou", { error: e.message.slice(0, 300), uncertain: e.uncertain }, now);
    await logAgentEvent(
      "social-media",
      e.uncertain ? "warn" : "error",
      e.uncertain ? "post.uncertain" : "post.failed",
      e.uncertain ? `A publicação de "${post.topic}" ficou sem confirmação: pode ter saído. Confira no Instagram antes de agir.` : `Falha ao publicar "${post.topic}": ${e.message}`,
      { post_id: post.id }
    );
    notify(e.uncertain ? "Publicação sem confirmação" : "Não foi possível publicar o post", e.uncertain ? `Confira no Instagram se "${post.topic}" saiu.` : e.message.slice(0, 120));
    return { ok: false, error: e.uncertain ? "Sem confirmação do Instagram: o post pode ter saído. Confira antes de tentar de novo." : e.message, post: failed };
  }
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
  const reopened = await setStatus(post, "pendente", { error: null, expires_at: new Date(now.getTime() + 2 * 86_400_000).toISOString() }, now);
  if (reopened.approval_id) await agentRepo().update("approvals", reopened.approval_id, { status: "pendente", decided_by: null, decided_at: null, expires_at: reopened.expires_at });
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

/** Propostas sem decisão que passaram do prazo viram "expirado". */
export async function expireStalePosts(now: Date = new Date()): Promise<number> {
  const stale = (await agentRepo().list("social_posts", { where: { status: "pendente" } })).filter((p) => p.expires_at <= now.toISOString());
  for (const p of stale) {
    await setStatus(p, "expirado", {}, now);
    await syncApproval(p, "expirado", null, now);
  }
  return stale.length;
}

/** Posts presos em "publicando" (o processo caiu no meio) viram falha incerta: não se sabe se saiu. */
export async function reconcileStuckPublishing(now: Date = new Date(), olderThanMs = 10 * 60_000): Promise<number> {
  const stuck = (await agentRepo().list("social_posts", { where: { status: "publicando" } })).filter((p) => now.getTime() - Date.parse(p.updated_at) > olderThanMs);
  for (const p of stuck) await setStatus(p, "falhou", { error: "Publicação interrompida sem desfecho conhecido.", uncertain: true }, now);
  return stuck.length;
}
