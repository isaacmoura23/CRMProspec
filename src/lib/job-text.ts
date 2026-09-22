import { canonicalUrl } from "@/lib/safe-url";
import type { WorkMode } from "@/types/career";

/** Utilitários puros sobre anúncios de vaga (testáveis sem rede). */

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Chave de deduplicação entre fontes: a mesma vaga publicada em dois
 * agregadores tem empresa e título iguais (normalizados). Quando só há a
 * URL (importação manual), a URL canônica é a chave.
 */
export function jobCanonicalKey(input: { company: string; title: string; location?: string | null; url?: string }): string {
  const company = slug(input.company);
  const title = slug(input.title).replace(/\b(vaga|job|opening|position|remote|remoto|hibrido|presencial|pj|clt|sr|jr|pl)\b/g, "").replace(/\s+/g, " ").trim();
  if (company && title) return `${company}|${title}`;
  if (input.url) return `url|${canonicalUrl(input.url)}`;
  return `${company}|${title}|${slug(input.location ?? "")}`;
}

export function detectWorkMode(text: string): WorkMode | null {
  const t = text.toLowerCase();
  if (/\b(remoto|remote|home ?office|100% remoto|anywhere|work from home)\b/.test(t)) return "remoto";
  if (/\b(h[íi]brido|hybrid)\b/.test(t)) return "hibrido";
  if (/\b(presencial|on-?site|in office|in-office)\b/.test(t)) return "presencial";
  return null;
}

export function detectLanguage(text: string): "pt" | "en" | "es" | null {
  const t = ` ${text.toLowerCase().slice(0, 3000)} `;
  const pt = (t.match(/\b(você|para|com|não|experiência|vaga|requisitos|nós|empresa)\b/g) ?? []).length;
  const en = (t.match(/\b(the|and|with|you|experience|requirements|we|our|team)\b/g) ?? []).length;
  const es = (t.match(/\b(usted|con|experiencia|requisitos|nosotros|empresa|equipo|puesto)\b/g) ?? []).length;
  const max = Math.max(pt, en, es);
  if (max < 3) return null;
  return max === pt ? "pt" : max === en ? "en" : "es";
}

const REQ_HEADING = /(requisitos|requirements|qualifications|o que esperamos|what we expect|você precisa|you need|must have|obrigat[óo]rio|required|responsabilidades|responsibilities|what you.ll do|o que você vai fazer)/i;
const NICE_HEADING = /(desej[áa]vel|diferencia(l|is)|nice to have|bonus|plus|preferred|será um diferencial)/i;

/**
 * Separa requisitos obrigatórios de desejáveis pelo cabeçalho da lista em
 * que aparecem. Linhas fora de qualquer seção reconhecida não viram
 * requisito — melhor faltar do que tratar "benefícios" como exigência.
 */
export function extractRequirements(text: string): { required: string[]; desirable: string[] } {
  const required: string[] = [];
  const desirable: string[] = [];
  let mode: "req" | "nice" | null = null;
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length < 80 && NICE_HEADING.test(line)) { mode = "nice"; continue; }
    if (line.length < 80 && REQ_HEADING.test(line)) { mode = "req"; continue; }
    if (line.length < 60 && /^(benef[íi]cios|benefits|sobre (a|nós)|about|salário|salary|como se candidatar|how to apply)/i.test(line)) { mode = null; continue; }
    if (!mode) continue;
    const item = line.replace(/^[-–•*·▪●]\s*/, "").trim();
    if (item.length < 2 || item.length > 220) continue;
    (mode === "req" ? required : desirable).push(item);
  }
  return { required: required.slice(0, 30), desirable: desirable.slice(0, 20) };
}

/**
 * E-mail de candidatura: só vale se o próprio anúncio disser para enviar
 * currículo/candidatura para ele. Um e-mail solto (ex.: de contato ou de
 * privacidade) não é destino de candidatura.
 */
export function findApplicationEmail(text: string): { email: string; evidence: string } | null {
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const lines = text.split(/\n/);
  for (const line of lines) {
    const emails = line.match(re);
    if (!emails) continue;
    if (/(candidat|curr[íi]culo|cv\b|resume|apply|aplicar|envie|enviar|send|interessad|vaga|hiring|recruit|talent|jobs?@|vagas?@|rh@|careers?@)/i.test(line)) {
      const email = emails.find((e) => !/privac|noreply|no-reply|dpo@|legal@/i.test(e));
      if (email) return { email: email.toLowerCase(), evidence: line.trim().slice(0, 240) };
    }
  }
  return null;
}

/** Apenas texto: nunca deixar um `mailto:` ou `<a>` cair no destinatário. */
export function isValidEmail(email: string): boolean {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(email) && !/[\r\n\s<>,;]/.test(email) && email.length <= 254;
}

/** Cabeçalhos de e-mail não podem conter quebras de linha (injeção de header). */
export function sanitizeHeader(value: string, max = 200): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Texto simples → HTML seguro com parágrafos. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Neutraliza injeção de fórmula ao exportar CSV. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}
