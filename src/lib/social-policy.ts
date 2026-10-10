import crypto from "node:crypto";
import { normalizeText } from "@/lib/conversation-policy";
import { validatePublicUrl } from "@/lib/safe-url";
import type { PostFormat, SocialPost, SocialPostStatus } from "@/types/agents";

/**
 * Regras puras das publicações no Instagram — testáveis sem servidor.
 *
 * O princípio é um só: **nada sai sem o seu clique** — em "Aprovar e publicar" (agora) ou em
 * "Aprovar e agendar" (para uma data, item a item, nunca em lote). A máquina de estados abaixo só
 * permite chegar a "publicando" a partir de "aprovado" (o clique de publicar) ou de "agendado"
 * (o clique de agendar, quando chega a hora e o publicador reconfere tudo).
 */

export const CAPTION_MIN_CHARS = 20;
export const CAPTION_MAX_CHARS = 2_200;
export const HASHTAGS_MAX = 30;

/** Estados a partir dos quais cada estado pode ir. `publicado`, `recusado` e `expirado` são finais. */
export const POST_TRANSITIONS: Record<SocialPostStatus, SocialPostStatus[]> = {
  rascunho: ["pendente", "recusado", "expirado"],
  pendente: ["aprovado", "agendado", "recusado", "expirado"],
  // aprovado → publicando é a passagem protegida: só a ação do botão a executa.
  aprovado: ["publicando", "falhou"],
  // agendado: você aprovou para uma data. Sai dali para publicar (a hora chegou e tudo foi reconferido),
  // voltar a pendente (você cancelou o agendamento) ou falhar (reconferência reprovada ou janela perdida).
  agendado: ["publicando", "pendente", "falhou"],
  publicando: ["publicado", "falhou"],
  // Falha sem incerteza pode ser reaberta para um novo clique; com incerteza, só conferência.
  falhou: ["pendente", "publicado"],
  publicado: [],
  recusado: [],
  expirado: [],
};

export function canMovePost(from: SocialPostStatus, to: SocialPostStatus): boolean {
  return POST_TRANSITIONS[from].includes(to);
}

/** Barreiras do texto de uma legenda. Devolve o motivo da recusa, ou `null`. */
export function checkCaption(caption: string, neverSay: readonly string[] = []): string | null {
  const text = caption.trim();
  if (text.length < CAPTION_MIN_CHARS) return "Legenda curta demais.";
  if (text.length > CAPTION_MAX_CHARS) return `Legenda longa demais (máximo ${CAPTION_MAX_CHARS} caracteres).`;
  if (/\{\{|\}\}|\[(nome|empresa|cidade|servi[cç]o)\]|undefined|null\b/i.test(text)) return "Texto com variável não preenchida.";
  if ((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > HASHTAGS_MAX) return `Hashtags demais (máximo ${HASHTAGS_MAX}).`;
  if (/https?:\/\/|www\./i.test(text)) return "Link na legenda não é clicável no Instagram e parece spam: use o link da bio.";
  if (/\bgarant(ido|imos|ia)\b|100\s?%|resultado garantido|sem risco|cura\b|milagr/i.test(text)) return "Promessa de resultado não é permitida.";
  const lower = normalizeText(text);
  for (const phrase of neverSay) {
    const p = normalizeText(phrase);
    if (p.length >= 4 && lower.includes(p)) return `Contém uma frase proibida pelo perfil da empresa: "${phrase}".`;
  }
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "");
  if (letters.length > 40 && upper.length / letters.length > 0.4) return "Texto em maiúsculas parece spam.";
  return null;
}

/** A mídia do post: endereço público em https, sem credencial e fora de faixas internas. */
export function checkImageUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return "O post precisa de uma imagem (endereço público em https).";
  const v = validatePublicUrl(url.trim());
  if (!v.ok) return `Endereço da imagem não aceito: ${v.reason}.`;
  if (v.url.protocol !== "https:") return "O endereço da imagem precisa ser https.";
  return null;
}

export const FORMAT_LABEL: Record<PostFormat, string> = { feed: "Feed", reel: "Reels", story: "Stories" };

/* ------------------------------ Agendamento ------------------------------ */

/** Antecedência mínima e máxima para agendar. Antes disso é "publicar agora"; depois, longe demais para um criativo que expira. */
export const SCHEDULE_MIN_MS = 5 * 60_000;
export const SCHEDULE_MAX_MS = 30 * 86_400_000;

/** Esta data serve para agendar? Devolve o motivo da recusa, ou `null`. */
export function checkSchedule(at: Date, now: Date): string | null {
  if (Number.isNaN(at.getTime())) return "Data de agendamento inválida.";
  if (at.getTime() < now.getTime() + SCHEDULE_MIN_MS) return "Agende para pelo menos 5 minutos à frente (ou use \"Aprovar e publicar\" para sair agora).";
  if (at.getTime() > now.getTime() + SCHEDULE_MAX_MS) return "Agende para no máximo 30 dias à frente.";
  return null;
}

/**
 * Resumo (SHA-256) do que você aprovou: formato, legenda, a mídia exata (resumo do arquivo, ou o
 * endereço informado à mão) e a data. O publicador agendado recalcula na hora de sair: qualquer
 * diferença significa que algo mudou depois do seu clique, e nada é publicado.
 */
export function postDigest(p: { format: PostFormat; caption: string; media: string; scheduledAt: string | null }): string {
  return crypto.createHash("sha256").update(JSON.stringify([p.format, p.caption.trim(), p.media, p.scheduledAt])).digest("hex");
}

export type DueState = "wait" | "go" | "late";

/** Chegou a hora? `late` = passou da janela tolerada: não publica fora de hora, avisa. */
export function dueState(scheduledAt: string, now: Date, lateWindowHours: number): DueState {
  const at = Date.parse(scheduledAt);
  if (Number.isNaN(at) || at > now.getTime()) return "wait";
  return now.getTime() - at > lateWindowHours * 3_600_000 ? "late" : "go";
}

export type PublishCheck = { ok: true } | { ok: false; reason: string };

/**
 * Este post pode ser publicado (ou agendado) AGORA, pelo clique? `mediaUrl` é a mídia que vai de fato:
 * o endereço informado à mão ou o do criativo aprovado (o chamador resolve).
 */
export function publishable(post: Pick<SocialPost, "status" | "caption" | "expires_at"> & { image_url?: string | null }, neverSay: readonly string[], now: Date, mediaUrl: string | null | undefined = post.image_url): PublishCheck {
  if (post.status !== "pendente") return { ok: false, reason: `O post está "${post.status}": só um post pendente pode ser publicado.` };
  if (post.expires_at <= now.toISOString()) return { ok: false, reason: "A proposta expirou. O agente fará uma nova." };
  const caption = checkCaption(post.caption, neverSay);
  if (caption) return { ok: false, reason: caption };
  const image = checkImageUrl(mediaUrl);
  if (image) return { ok: false, reason: image };
  return { ok: true };
}

/** Legenda final: o texto mais as hashtags configuradas (sem repetir as que o texto já tem). */
export function withHashtags(caption: string, hashtags: readonly string[]): string {
  const text = caption.trim();
  const have = new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((h) => h.slice(1).toLowerCase()));
  const extra = hashtags.filter((h) => !have.has(h.toLowerCase())).map((h) => `#${h}`);
  return extra.length > 0 ? `${text}\n\n${extra.join(" ")}` : text;
}
