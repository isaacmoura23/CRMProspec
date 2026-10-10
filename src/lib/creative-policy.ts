import { normalizeText } from "@/lib/conversation-policy";
import { validatePublicUrl } from "@/lib/safe-url";
import { textNodes, words } from "@/lib/site-verify";
import type { Creative, CreativeFormat, CreativeStatus, SiteCheck } from "@/types/agents";

/**
 * Regras puras dos criativos (imagens e vídeos da própria empresa) — testáveis sem navegador nem ffmpeg.
 *
 * O princípio é o mesmo do site: **só o texto que a empresa já disse** aparece na arte (título, texto
 * e chamada vindos do post ou da campanha, mais o nome da empresa), nenhum link, nenhuma pessoa,
 * foto ou marca de terceiros, e nada de código ativo no HTML que vira imagem.
 */

export interface CreativeSpec {
  width: number;
  height: number;
  kind: "imagem" | "video";
  label: string;
}

/** Medidas pedidas pelo Instagram/Meta: feed 4:5, stories e reels 9:16, anúncio quadrado. */
export const CREATIVE_SPECS: Record<CreativeFormat, CreativeSpec> = {
  feed: { width: 1080, height: 1350, kind: "imagem", label: "Feed (4:5)" },
  story: { width: 1080, height: 1920, kind: "imagem", label: "Stories (9:16)" },
  reel: { width: 1080, height: 1920, kind: "video", label: "Reels (9:16)" },
  anuncio: { width: 1080, height: 1080, kind: "imagem", label: "Anúncio (1:1)" },
};

/** Texto que cabe na arte: título curto, uma frase de apoio e uma chamada. */
export const COPY_LIMITS = { headline: 60, body: 140, cta: 32 } as const;

/** Vídeo: Reels aceitam de 3 s a 90 s; aqui, motion graphics curtos. */
export const VIDEO_LIMITS = { minSeconds: 3, maxSeconds: 60, maxBytes: 90 * 1024 * 1024 } as const;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export interface CreativeCopy {
  headline: string;
  body: string;
  cta: string;
  brand: string;
}

/** Corta em fim de palavra, sem reticências: o texto da arte é curto e termina inteiro. */
export function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

/** Primeira frase (até o primeiro ponto final, ! ou ?), para a linha de apoio. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1]! : t;
}

const PROMISES = /\bgarant(ido|imos|ia)\b|100\s?%|resultado garantido|sem risco|cura\b|milagr|emagre[cç]a|ganhe dinheiro/i;

/** Barreiras do texto da arte. Devolve o motivo, ou `null`. */
export function checkCreativeCopy(c: CreativeCopy, neverSay: readonly string[] = []): string | null {
  if (c.headline.trim().length < 3) return "A arte precisa de um título.";
  if (c.headline.length > COPY_LIMITS.headline) return `Título longo demais para a arte (máximo ${COPY_LIMITS.headline} caracteres).`;
  if (c.body.length > COPY_LIMITS.body) return `Texto longo demais para a arte (máximo ${COPY_LIMITS.body} caracteres).`;
  if (c.cta.length > COPY_LIMITS.cta) return `Chamada longa demais para a arte (máximo ${COPY_LIMITS.cta} caracteres).`;
  const all = [c.headline, c.body, c.cta, c.brand].join(" \n ");
  if (/\{\{|\}\}|\[(nome|empresa|cidade|servi[cç]o)\]|undefined|null\b/i.test(all)) return "Texto com variável não preenchida.";
  if (/https?:\/\/|www\./i.test(all)) return "A arte não leva link: use o link da bio ou o botão do anúncio.";
  if (PROMISES.test(all)) return "Promessa de resultado não é permitida.";
  const lower = normalizeText(all);
  for (const phrase of neverSay) {
    const p = normalizeText(phrase);
    if (p.length >= 4 && lower.includes(p)) return `Contém uma frase proibida pelo perfil da empresa: "${phrase}".`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Estados                                                             */
/* ------------------------------------------------------------------ */

/** `aprovado` só se chega por clique (o do post ou o do próprio criativo). */
export const CREATIVE_TRANSITIONS: Record<CreativeStatus, CreativeStatus[]> = {
  pendente: ["aprovado", "recusado", "expirado", "falhou"],
  // aprovado → pendente é revogar a aprovação (você cancelou o agendamento): a mídia deixa de ser servida.
  aprovado: ["expirado", "pendente"],
  recusado: [],
  expirado: [],
  falhou: [],
};

export function canMoveCreative(from: CreativeStatus, to: CreativeStatus): boolean {
  return CREATIVE_TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* Endereços                                                           */
/* ------------------------------------------------------------------ */

export const CREATIVE_FILES = ["creative.png", "creative.mp4", "poster.png"] as const;
export type CreativeFile = (typeof CREATIVE_FILES)[number];

export const isCreativeToken = (t: string): boolean => /^[a-f0-9]{48}$/.test(t);
export const isCreativeFile = (f: string): f is CreativeFile => (CREATIVE_FILES as readonly string[]).includes(f);

/** Arquivo principal de um criativo: o que é publicado. */
export const mainFile = (c: Pick<Creative, "kind">): CreativeFile => (c.kind === "video" ? "creative.mp4" : "creative.png");

/**
 * Endereço público do CRM (PUBLIC_BASE_URL ou um túnel), só se servir para o Instagram buscar a mídia:
 * https, sem credencial, fora de faixas internas. `null` = "sem hospedagem".
 */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  const v = validatePublicUrl(raw);
  if (!v.ok || v.url.protocol !== "https:") return null;
  return v.url.origin;
}

/** Endereço público da mídia, ou `null` sem hospedagem. */
export function creativeMediaUrl(c: Pick<Creative, "token" | "kind">, env: Record<string, string | undefined> = process.env): string | null {
  const base = publicBaseUrl(env);
  return base ? `${base}/midia/${c.token}/${mainFile(c)}` : null;
}

/** A mídia pode ser servida de fora? Só criativo aprovado e dentro do prazo. */
export function servable(c: Pick<Creative, "status" | "expires_at">, now: Date): boolean {
  return c.status === "aprovado" && c.expires_at > now.toISOString();
}

/* ------------------------------------------------------------------ */
/* HTML da arte                                                        */
/* ------------------------------------------------------------------ */

const check = (name: string, ok: boolean, detail: string): SiteCheck => ({ name, ok, detail });

/**
 * Palavras que a arte pode ter: as do texto aprovado, as do nome da empresa e as do vocabulário
 * fixo (nenhum, hoje: a arte só mostra o que a empresa disse).
 */
export function allowedCreativeWords(copy: CreativeCopy, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  for (const v of [copy.headline, copy.body, copy.cta, copy.brand, ...extra]) if (v) for (const w of words(v)) out.add(w);
  return out;
}

/** Verificação estática do HTML que vira imagem (vale para o modelo de arte e para o que o Claude Code escrever). */
export function verifyCreativeHtml(html: string, copy: CreativeCopy, spec: Pick<CreativeSpec, "width" | "height">): SiteCheck[] {
  const checks: SiteCheck[] = [];
  const markup = html
    .replace(/<style[\s\S]*?<\/style>/gi, "<style></style>")
    .replace(/<svg[\s\S]*?<\/svg>/gi, (svg) => svg.replace(/="[^"]*"|='[^']*'/g, '=""').replace(/>[^<]*</g, "><"))
    .replace(/="[^"]*"|='[^']*'/g, '=""')
    .replace(/>[^<]*</g, "><");
  const styles = (html.match(/<style[\s\S]*?<\/style>/gi) ?? []).join("\n") + (html.match(/\sstyle=["'][^"']*["']/gi) ?? []).join("\n");

  const banned: string[] = [];
  for (const [re, label, target] of [
    [/<script\b/i, "script", markup],
    [/<iframe\b|<frame\b/i, "iframe", markup],
    [/<form\b/i, "formulário", markup],
    [/<object\b|<embed\b/i, "objeto embutido", markup],
    [/<video\b|<audio\b|<canvas\b/i, "mídia", markup],
    [/<link\b/i, "folha de estilo externa", markup],
    [/<img\b|<image\b/i, "imagem (foto ou arquivo)", markup],
    [/\ssrc\s*=|\sxlink:href\s*=/i, "recurso com src", html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/>[^<]*</g, "><")],
    [/\son[a-z]+\s*=/i, "manipulador de evento", markup],
    [/@import|url\(\s*["']?(?!#)/i, "recurso externo no CSS", styles],
  ] as Array<[RegExp, string, string]>) {
    if (re.test(target)) banned.push(label);
  }
  checks.push(check("sem código nem recurso externo", banned.length === 0, banned.length === 0 ? "Só HTML, CSS e SVG dentro da própria arte." : `Encontrado: ${banned.join(", ")}.`));

  const hrefs = [...html.matchAll(/\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!).filter((h) => !h.startsWith("#"));
  checks.push(check("sem links", hrefs.length === 0, hrefs.length === 0 ? "A arte não tem link." : `Link(s) na arte: ${hrefs.slice(0, 2).join(", ")}.`));

  const ok = allowedCreativeWords(copy);
  const foreign = new Set<string>();
  for (const node of textNodes(html)) for (const w of words(node)) if (!ok.has(w)) foreign.add(w);
  checks.push(check("texto só do que a empresa disse", foreign.size === 0, foreign.size === 0 ? "Toda palavra da arte vem do título, texto ou chamada aprovados." : `Palavras fora do texto: ${[...foreign].slice(0, 6).join(", ")}.`));

  const size = new RegExp(`width\\s*:\\s*${spec.width}px`, "i").test(styles) && new RegExp(`height\\s*:\\s*${spec.height}px`, "i").test(styles);
  checks.push(check("tamanho da tela da arte", size, size ? `Arte de ${spec.width}×${spec.height}.` : `A arte precisa declarar width:${spec.width}px e height:${spec.height}px no CSS.`));

  return checks;
}

/** Cabeçalho PNG (IHDR): largura e altura sem decodificar a imagem. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
