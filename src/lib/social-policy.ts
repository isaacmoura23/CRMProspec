import { normalizeText } from "@/lib/conversation-policy";
import { validatePublicUrl } from "@/lib/safe-url";
import type { SocialPost, SocialPostStatus } from "@/types/agents";

/**
 * Regras puras das publicações no Instagram — testáveis sem servidor.
 *
 * O princípio é um só: **nada sai sem o clique em "Aprovar e publicar"**. Por isso
 * a máquina de estados abaixo só permite chegar a "publicando" a partir de
 * "pendente", e só a ação do botão faz essa passagem.
 */

export const CAPTION_MIN_CHARS = 20;
export const CAPTION_MAX_CHARS = 2_200;
export const HASHTAGS_MAX = 30;

/** Estados a partir dos quais cada estado pode ir. `publicado`, `recusado` e `expirado` são finais. */
export const POST_TRANSITIONS: Record<SocialPostStatus, SocialPostStatus[]> = {
  rascunho: ["pendente", "recusado", "expirado"],
  pendente: ["aprovado", "recusado", "expirado"],
  // aprovado → publicando é a passagem protegida: só a ação do botão a executa.
  aprovado: ["publicando", "falhou"],
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

/** A imagem do post: endereço público em https, sem credencial e fora de faixas internas. */
export function checkImageUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return "O post precisa de uma imagem (endereço público em https).";
  const v = validatePublicUrl(url.trim());
  if (!v.ok) return `Endereço da imagem não aceito: ${v.reason}.`;
  if (v.url.protocol !== "https:") return "O endereço da imagem precisa ser https.";
  return null;
}

export type PublishCheck = { ok: true } | { ok: false; reason: string };

/** Este post pode ser publicado AGORA (pelo clique)? */
export function publishable(post: Pick<SocialPost, "status" | "caption" | "image_url" | "expires_at">, neverSay: readonly string[], now: Date): PublishCheck {
  if (post.status !== "pendente") return { ok: false, reason: `O post está "${post.status}": só um post pendente pode ser publicado.` };
  if (post.expires_at <= now.toISOString()) return { ok: false, reason: "A proposta expirou. O agente fará uma nova." };
  const caption = checkCaption(post.caption, neverSay);
  if (caption) return { ok: false, reason: caption };
  const image = checkImageUrl(post.image_url);
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
