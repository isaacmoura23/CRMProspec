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

/** Perfis de construtores de site/plataformas — nunca são o Instagram da empresa */
const IG_JUNK = new Set([
  "wix", "wixsite", "wixstudio", "shopify", "shopifybr", "wordpress",
  "godaddy", "squarespace", "canva", "webnode", "hostgator", "hostinger",
  "instagram", "meta", "facebook", "whatsapp", "google", "nuvemshop",
  "lojaintegrada", "tray", "vtex", "elementor", "duda", "rdstation",
]);

export function extractInstagramHandle(text: string): string | null {
  // boundary antes do domínio evita capturar cdninstagram.com e afins
  const re = /(?:^|[^\w.-])(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const handle = instagramHandle(m[1]);
    if (handle && !IG_JUNK.has(handle.toLowerCase())) return `@${handle}`;
  }
  return null;
}

/** Só letras e números, para comparar handle × nome da empresa × domínio */
function bareSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Escolhe o Instagram da PRÓPRIA empresa dentro do HTML do site.
 * Um site costuma linkar vários perfis (agência que o construiu, parceiros,
 * widgets) — o da empresa é o que se parece com o nome/domínio dela ou o
 * que mais se repete (header + footer).
 */
export function pickInstagramHandle(
  html: string,
  hints: { companyName?: string; websiteUrl?: string }
): string | null {
  const counts = new Map<string, number>();
  const re = /(?:^|[^\w.-])(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const handle = instagramHandle(m[1]);
    if (!handle || IG_JUNK.has(handle.toLowerCase())) continue;
    counts.set(handle, (counts.get(handle) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const nameSlug = hints.companyName ? bareSlug(hints.companyName) : "";
  let domainSlug = "";
  if (hints.websiteUrl) {
    try {
      domainSlug = bareSlug(
        new URL(hints.websiteUrl).hostname.replace(/^www\./, "").split(".")[0] ?? ""
      );
    } catch {
      /* URL inválida — segue sem o domínio */
    }
  }

  let best: string | null = null;
  let bestScore = -1;
  for (const [handle, freq] of counts) {
    const hSlug = bareSlug(handle);
    let score = freq;
    const similar = (a: string, b: string) =>
      a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
    if (nameSlug && similar(hSlug, nameSlug)) score += 10;
    if (domainSlug && similar(hSlug, domainSlug)) score += 10;
    if (score > bestScore) {
      bestScore = score;
      best = handle;
    }
  }
  return best ? `@${best}` : null;
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

/** Provedores de e-mail pessoais/gratuitos: conta da própria empresa, não de fornecedor. */
const PROVEDORES_PUBLICOS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br",
  "live.com", "msn.com", "yahoo.com", "yahoo.com.br", "icloud.com", "me.com", "uol.com.br",
  "bol.com.br", "terra.com.br", "ig.com.br", "globo.com", "sapo.pt", "clix.pt",
]);

/** Caixas que existem por obrigação legal/técnica e não atendem prospecção. */
const CAIXAS_IGNORADAS = /^(no-?reply|nao-?responda|postmaster|webmaster|abuse|dpo|privacidade|privacy|suporte@wix|admin@wordpress)/i;

function dominioDe(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** `contato@imob.com.br` combina com o site `imob.com.br` (e com seus subdomínios). */
function mesmoDominio(email: string, site: string): boolean {
  const d = email.split("@")[1] ?? "";
  return d === site || d.endsWith(`.${site}`) || site.endsWith(`.${d}`);
}

/**
 * Escolhe o e-mail de contato DA EMPRESA dentro do HTML do site.
 *
 * Pegar o primeiro e-mail que aparece é o que fazia esta função antes — e o
 * primeiro costuma ser o do rodapé "desenvolvido por…". Numa base real de 84
 * imobiliárias, o mesmo endereço de uma agência de sites foi gravado como
 * contato de cinco empresas diferentes: uma campanha escreveria para o
 * fornecedor, não para o cliente.
 *
 * Ordem de preferência:
 *   1. e-mail do mesmo domínio do site (é a empresa);
 *   2. e-mail em provedor público (a empresa usando Gmail/Hotmail);
 *   3. nenhum — um endereço de outro domínio corporativo é de terceiro.
 */
export function pickEmail(html: string, websiteUrl?: string): string | null {
  const site = dominioDe(websiteUrl);
  const encontrados: string[] = [];

  const push = (valor: string | undefined) => {
    if (!valor) return;
    const lower = valor.toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(lower)) return;
    if (/(example\.|sentry|wixpress|schema\.org|w3\.org|\.wixpress|godaddy|hostgator)/.test(lower)) return;
    if (CAIXAS_IGNORADAS.test(lower)) return;
    if (!encontrados.includes(lower)) encontrados.push(lower);
  };

  // `mailto:` primeiro: é um endereço que o site publicou para contato.
  for (const m of html.matchAll(/mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi)) push(m[1]);
  for (const m of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) push(m[0]);
  if (encontrados.length === 0) return null;

  if (site) {
    const proprio = encontrados.find((e) => mesmoDominio(e, site));
    if (proprio) return proprio;
  }
  const publico = encontrados.find((e) => PROVEDORES_PUBLICOS.has(e.split("@")[1] ?? ""));
  if (publico) return publico;

  // Sobrou só endereço de outro domínio: é de terceiro (agência, plataforma,
  // portal). Melhor não ter e-mail do que ter o e-mail errado.
  return null;
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

  // dados de demonstração são sintéticos e completos — os domínios não
  // existem de verdade, então visitar seria lento e sem sentido
  if (out.source === "diretorio" || out.source === "demo") return out;

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
      const ig = pickInstagramHandle(html, {
        companyName: out.company_name,
        websiteUrl: out.website,
      });
      if (ig) {
        out.instagram = ig;
        out.instagram_active = true; // site aponta para o perfil — presença confirmada
      }
    }
    if (!out.facebook) out.facebook = extractFacebook(html) ?? undefined;
    if (!out.whatsapp) out.whatsapp = extractWhatsapp(html) ?? undefined;
    if (!out.email) out.email = pickEmail(html, out.website) ?? undefined;
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
