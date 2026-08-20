import "server-only";
import { instagramHandle } from "@/lib/utils";
import type { Lead, RawLead } from "@/types";

/**
 * Enriquecimento real de leads: visita o site (ou agregador tipo Linktree)
 * da empresa e extrai Instagram, Facebook, e-mail, WhatsApp e sinais de
 * qualidade/marketing. Tudo best-effort — falha de rede nunca derruba o lead.
 */

const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 400_000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.6",
};

interface FetchResult {
  /** null = erro de rede/DNS/timeout */
  status: number | null;
  html: string | null;
}

async function fetchHtml(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: res.status, html: null };
    const type = res.headers.get("content-type") ?? "";
    if (type && !type.includes("html")) return { status: res.status, html: null };
    const text = await res.text();
    return { status: res.status, html: text.slice(0, MAX_HTML_BYTES) };
  } catch {
    return { status: null, html: null };
  }
}

export function extractInstagramHandle(text: string): string | null {
  // boundary antes do domínio evita capturar cdninstagram.com e afins
  const re = /(?:^|[^\w.-])(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const handle = instagramHandle(m[1]);
    if (handle) return `@${handle}`;
  }
  return null;
}

const FB_RESERVED = new Set([
  "sharer", "share.php", "plugins", "tr", "dialog", "login", "policies",
  "profile.php", "pages", "groups", "events", "hashtag", "watch",
]);

function extractFacebook(text: string): string | null {
  const re = /facebook\.com\/([A-Za-z0-9._-]{3,60})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const slug = m[1]!.replace(/\.$/, "");
    if (!FB_RESERVED.has(slug.toLowerCase())) return slug;
  }
  return null;
}

export function extractWhatsapp(text: string): string | null {
  const m =
    /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s>]*&)?phone=)\+?(\d{8,15})/.exec(text);
  return m ? `+${m[1]}` : null;
}

function extractEmail(text: string): string | null {
  const mailto = /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(text);
  const candidate =
    mailto?.[1] ??
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.exec(text)?.[0] ??
    null;
  if (!candidate) return null;
  const lower = candidate.toLowerCase();
  if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(lower)) return null;
  if (/(example\.|sentry|wixpress|schema\.org|w3\.org)/.test(lower)) return null;
  return lower;
}

/** Número de celular BR/PT — forte indício de WhatsApp comercial */
export function looksLikeMobile(phone: string | undefined): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  // Brasil: DDI 55 + DDD + 9xxxxxxxx (11 dígitos locais)
  if (/^(55)?\d{2}9\d{8}$/.test(digits)) return true;
  // Portugal: DDI 351 + 9xxxxxxxx
  if (/^(351)?9[1236]\d{7}$/.test(digits)) return true;
  return false;
}

const CHEAP_BUILDERS = /(blogspot\.|wixsite\.com|webnode\.|site\.google\.com|000webhost|comunidades\.net)/i;

function assessWebsiteQuality(url: string, html: string): Lead["website_quality"] {
  if (CHEAP_BUILDERS.test(url)) return "ruim";

  const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);
  const hasOg = /property=["']og:/i.test(html);
  const hasAnalytics = /(googletagmanager|gtag\(|fbq\(|analytics\.js|hotjar|clarity\.ms)/i.test(html);

  const yearMatch = /(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/i.exec(html);
  const year = yearMatch ? parseInt(yearMatch[1]!, 10) : null;
  const currentYear = new Date().getFullYear();

  if (!hasViewport) return "desatualizado";
  if (year && year <= currentYear - 3) return "desatualizado";
  if (hasOg || hasAnalytics) return "bom";
  return "desconhecido";
}

/**
 * Enriquece um RawLead visitando site/agregador. Retorna uma cópia —
 * nunca lança: no pior caso devolve o lead como veio.
 */
export async function enrichRawLead(raw: RawLead): Promise<RawLead> {
  const out: RawLead = { ...raw };

  // WhatsApp por heurística de número móvel, mesmo sem visitar o site
  if (!out.whatsapp && looksLikeMobile(out.phone)) {
    out.whatsapp = out.phone;
  }

  const target = out.website ?? out.social_link;
  if (!target) return out;

  const { status, html } = await fetchHtml(target);

  if (out.website) {
    if (html) {
      out.website_quality = assessWebsiteQuality(out.website, html);
    } else if (status === null || status === 404 || status === 410 || (status ?? 0) >= 500) {
      // site fora do ar ou inexistente — oportunidade real, mas site "ruim"
      out.website_quality = "ruim";
    }
    // 403/429 etc.: bloqueio de bot, não dá para julgar — mantém "desconhecido"
  }

  if (html) {
    if (!out.instagram) {
      const ig = extractInstagramHandle(html);
      if (ig) {
        out.instagram = ig;
        out.instagram_active = true; // site aponta para o perfil — presença confirmada
      }
    }
    if (!out.facebook) out.facebook = extractFacebook(html) ?? undefined;
    if (!out.whatsapp) out.whatsapp = extractWhatsapp(html) ?? undefined;
    if (!out.email) out.email = extractEmail(html) ?? undefined;
    if (!out.marketing_signals) {
      out.marketing_signals = /(googletagmanager|gtag\(|fbq\(|pixel|hotjar|clarity\.ms|mailchimp|rdstation)/i.test(html);
    }
  }

  return out;
}

/** Enriquece em lotes paralelos, chamando onProgress após cada lead concluído */
export async function enrichBatch(
  raws: RawLead[],
  onProgress?: (done: number) => void,
  batchSize = 6
): Promise<RawLead[]> {
  const out: RawLead[] = [];
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((raw) => enrichRawLead(raw).catch(() => raw))
    );
    out.push(...results);
    onProgress?.(out.length);
  }
  return out;
}
