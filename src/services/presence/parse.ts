import { extractWhatsapp, pickEmail, pickInstagramHandle } from "@/services/enrichment";
import type { RubricItem, SiteAssessment } from "@/types/agents";

/**
 * Leitura de páginas públicas para o dossiê. Tudo aqui é determinístico e
 * puro: recebe HTML, devolve fatos medidos. Nenhum texto da página é tratado
 * como instrução — ele só vira dado (e, quando citado, vira trecho curto,
 * sem marcação e sem quebra de linha).
 */

/** Trecho citável: sem marcação, sem controle, sem espaços repetidos, com tamanho máximo. */
export function cleanText(input: string, max = 160): string {
  const text = input
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Texto visível da página (sem scripts, estilos e marcação). */
export function visibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Conteúdo de uma tag <meta> por `name` ou `property`, em qualquer ordem de atributos. */
export function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
  if (a?.[1]) return cleanText(a[1], 400);
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${escaped}["']`, "i").exec(html);
  return b?.[1] ? cleanText(b[1], 400) : null;
}

function allMatches(html: string, re: RegExp, group = 1, limit = 8): string[] {
  const out: string[] = [];
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  for (const m of html.matchAll(global)) {
    const text = cleanText(m[group] ?? "", 120);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

const PLATFORMS: Array<[RegExp, string]> = [
  [/wp-content|wp-includes|wordpress/i, "WordPress"],
  [/cdn\.shopify\.com|shopify\.com\/s\/|Shopify\.theme/i, "Shopify"],
  [/static\.wixstatic\.com|wix\.com|X-Wix/i, "Wix"],
  [/nuvemshop|lojavirtualnuvem|tiendanube/i, "Nuvemshop"],
  [/lojaintegrada|cdn\.awsli\.com\.br/i, "Loja Integrada"],
  [/tray\.com\.br|tcdn\.com\.br|traycdn/i, "Tray"],
  [/vtex|vteximg|vtexassets/i, "VTEX"],
  [/squarespace/i, "Squarespace"],
  [/webflow/i, "Webflow"],
  [/blogspot\.|blogger\.com/i, "Blogger"],
  [/sites\.google\.com|site\.google\.com/i, "Google Sites"],
  [/webnode\./i, "Webnode"],
  [/godaddy|websitebuilder\.godaddy|secureserver\.net/i, "GoDaddy"],
];

const CHEAP_BUILDERS = /(blogspot\.|wixsite\.com|webnode\.|site\.google\.com|sites\.google\.com|000webhost|comunidades\.net|yolasite|weebly\.com)/i;

const LINK_BIO_HOSTS = ["linktr.ee", "beacons.ai", "bio.link", "campsite.bio", "taplink.cc", "linkin.bio", "lnk.bio", "linkbio.co", "solo.to", "bio.site", "carrd.co"];

export function isLinkBioUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return LINK_BIO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface SiteFacts {
  url: string;
  https: boolean;
  title: string | null;
  description: string | null;
  lang: string | null;
  h1: string[];
  h2: string[];
  wordCount: number;
  textSample: string;
  hasViewport: boolean;
  responsiveSignals: string[];
  platform: string | null;
  cheapBuilder: boolean;
  copyrightYear: number | null;
  outdatedSignals: string[];
  parked: boolean;
  underConstruction: boolean;
  imageCount: number;
  imagesWithoutAlt: number;
  ctas: string[];
  hasForm: boolean;
  phones: string[];
  email: string | null;
  whatsapp: string | null;
  socialProof: string[];
  prices: string[];
  themeColor: string | null;
  logo: string | null;
  isLinkBioPage: boolean;
  links: {
    instagram: string | null;
    facebook: string | null;
    youtube: string[];
    mercadolivre: string[];
    olx: string[];
    linkBio: string[];
    maps: string | null;
  };
}

const CTA_RE = /(or[cç]amento|solicit|fale (conosco|com)|entre em contato|contato|agende|agendar|reserve|compre|comprar|adicionar ao carrinho|whatsapp|chame|quero|saiba mais|ligue)/i;
const PROOF_RE = /(depoimento|avalia[cç][õo]es|o que (nossos )?clientes|nossos clientes|clientes (satisfeitos|atendidos)|portf[óo]lio|cases?\b|testemunh|resenhas?|nota \d|\d[.,]\d\s*(estrelas|\/5))/i;
const PARKED_RE = /(dom[ií]nio (est[aá] )?(à|a) venda|this domain is for sale|domain (is )?parked|buy this domain|registrar este dom[ií]nio|sedoparking|hugedomains)/i;
const CONSTRUCTION_RE = /(em constru[cç][aã]o|site em manuten[cç][aã]o|coming soon|em breve|under construction|volte em breve)/i;

function uniqueLinks(html: string, re: RegExp, limit = 4): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    const url = (m[0] ?? "").replace(/[)"'<>\s].*$/, "").replace(/&amp;/g, "&");
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

export function parseSite(html: string, finalUrl: string, hints: { companyName?: string } = {}): SiteFacts {
  const text = visibleText(html);
  const words = text.split(/\s+/).filter(Boolean);
  const lower = html.toLowerCase();
  const year = /(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/i.exec(html);
  const currentYear = new Date().getFullYear();

  const outdated: string[] = [];
  if (/<marquee|<blink|<font[\s>]|<center[\s>]/i.test(html)) outdated.push("marcação antiga (marquee, font ou center)");
  if (/swfobject|\.swf["']|flash/i.test(lower) && /<embed|<object|swfobject/i.test(lower)) outdated.push("depende de Flash");
  if (/jquery[-.]1\.\d|jquery\/1\.\d/i.test(html)) outdated.push("jQuery 1.x (anos 2010)");
  if (/<table[^>]*(width|bgcolor|cellpadding)[^>]*>/i.test(html) && (html.match(/<table/gi)?.length ?? 0) >= 4) outdated.push("layout feito com tabelas");
  if (year && Number(year[1]) <= currentYear - 3) outdated.push(`rodapé com © ${year[1]}`);

  const responsive: string[] = [];
  if (/@media[^{]*(max|min)-width/i.test(html)) responsive.push("regras @media");
  if (/bootstrap/i.test(html)) responsive.push("Bootstrap");
  if (/tailwind/i.test(html)) responsive.push("Tailwind");
  if (/display\s*:\s*(flex|grid)/i.test(html)) responsive.push("layout flex/grid");

  const platform = PLATFORMS.find(([re]) => re.test(html) || re.test(finalUrl))?.[1] ?? null;

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const withoutAlt = images.filter((i) => !/\balt=["'][^"']+["']/i.test(i)).length;

  const ctaSources = [...(html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []), ...(html.match(/<button\b[\s\S]*?<\/button>/gi) ?? [])];
  const ctas: string[] = [];
  for (const el of ctaSources) {
    const label = cleanText(el, 60);
    if (label && label.length >= 3 && CTA_RE.test(label) && !ctas.includes(label)) ctas.push(label);
    if (ctas.length >= 5) break;
  }

  const phones: string[] = [];
  for (const m of html.matchAll(/(?:tel:|\+?55\s?)?\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/g)) {
    const p = `(${m[1]}) ${m[2]}-${m[3]}`;
    if (Number(m[1]) >= 11 && !phones.includes(p)) phones.push(p);
    if (phones.length >= 3) break;
  }

  const proof: string[] = [];
  for (const m of text.matchAll(new RegExp(PROOF_RE.source, "gi"))) {
    const idx = m.index ?? 0;
    const around = cleanText(text.slice(Math.max(0, idx - 20), idx + 70), 90);
    if (!proof.includes(around)) proof.push(around);
    if (proof.length >= 3) break;
  }

  const prices: string[] = [];
  for (const m of text.matchAll(/R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/g)) {
    const idx = m.index ?? 0;
    const around = cleanText(text.slice(Math.max(0, idx - 40), idx + 30), 80);
    if (!prices.includes(around)) prices.push(around);
    if (prices.length >= 5) break;
  }

  const logoImg = images.find((i) => /logo/i.test(i));
  const logoSrc = logoImg ? /src=["']([^"']+)["']/i.exec(logoImg)?.[1] ?? null : null;
  const hex = /theme-color["'][^>]*content=["'](#[0-9a-f]{3,8})["']/i.exec(html)?.[1] ?? null;

  const links = {
    instagram: pickInstagramHandle(html, { companyName: hints.companyName, websiteUrl: finalUrl }),
    facebook: /facebook\.com\/([A-Za-z0-9._-]{3,60})/.exec(html)?.[1] ?? null,
    youtube: uniqueLinks(html, /https?:\/\/(?:www\.)?youtube\.com\/(?:@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/gi, 2),
    mercadolivre: uniqueLinks(html, /https?:\/\/(?:[\w-]+\.)?(?:mercadolivre\.com\.br|mercadolibre\.com)\/[^\s"'<>]*/gi, 2),
    olx: uniqueLinks(html, /https?:\/\/(?:[\w-]+\.)?olx\.com\.br\/[^\s"'<>]*/gi, 2),
    linkBio: uniqueLinks(html, new RegExp(`https?://(?:[\\w-]+\\.)?(?:${LINK_BIO_HOSTS.map((h) => h.replace(".", "\\.")).join("|")})/[^\\s"'<>]*`, "gi"), 2),
    maps: /https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)[^\s"'<>]*/i.exec(html)?.[0]?.replace(/&amp;/g, "&") ?? null,
  };

  return {
    url: finalUrl,
    https: finalUrl.startsWith("https://"),
    title: allMatches(html, /<title[^>]*>([\s\S]*?)<\/title>/i, 1, 1)[0] ?? null,
    description: metaContent(html, "description") ?? metaContent(html, "og:description"),
    lang: /<html[^>]*\blang=["']([\w-]+)["']/i.exec(html)?.[1] ?? null,
    h1: allMatches(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, 1, 5),
    h2: allMatches(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, 1, 8),
    wordCount: words.length,
    textSample: cleanText(text, 280),
    hasViewport: /<meta[^>]+name=["']?viewport/i.test(html),
    responsiveSignals: responsive,
    platform,
    cheapBuilder: CHEAP_BUILDERS.test(finalUrl) || CHEAP_BUILDERS.test(html.slice(0, 5_000)),
    copyrightYear: year ? Number(year[1]) : null,
    outdatedSignals: outdated,
    parked: PARKED_RE.test(text.slice(0, 4_000)) || (words.length < 80 && PARKED_RE.test(html)),
    underConstruction: words.length < 150 && CONSTRUCTION_RE.test(text.slice(0, 2_500)),
    imageCount: images.length,
    imagesWithoutAlt: withoutAlt,
    ctas,
    hasForm: /<form\b/i.test(html),
    phones,
    email: pickEmail(html, finalUrl),
    whatsapp: extractWhatsapp(html),
    socialProof: proof,
    prices,
    themeColor: hex,
    logo: logoSrc,
    isLinkBioPage: isLinkBioUrl(finalUrl),
    links,
  };
}

/* ------------------------------------------------------------------ */
/* Avaliação do site por rubrica                                       */
/* ------------------------------------------------------------------ */

const clamp = (n: number) => Math.max(0, Math.min(5, n));

/**
 * Nota do site por seis critérios, cada um com o dado medido que a justifica.
 * É a parte "por regras" da avaliação: mede o que o HTML diz (celular, títulos,
 * oferta, prova social, chamada para ação, atualização). O que só um olho vê
 * (legibilidade, estética) fica para a avaliação visual, opcional.
 */
export function assessSite(facts: SiteFacts, hints: { segment?: string | null; companyName?: string } = {}, now: Date = new Date()): SiteAssessment {
  const rubric: RubricItem[] = [];
  const currentYear = now.getFullYear();

  // 1) Responsividade
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.hasViewport) {
      score += 3;
      bits.push("tem a tag viewport");
    } else bits.push("sem a tag viewport: o site não se adapta ao celular");
    if (facts.responsiveSignals.length > 0) {
      score += 2;
      bits.push(`sinais de layout adaptável (${facts.responsiveSignals.join(", ")})`);
    } else bits.push("nenhum sinal de layout adaptável");
    rubric.push({ key: "responsividade", label: "Responsividade (celular)", score: clamp(score), evidence: bits.join("; ") });
  }

  // 2) Hierarquia
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.h1.length === 1) {
      score += 2;
      bits.push("um título principal (h1)");
    } else bits.push(facts.h1.length === 0 ? "sem título principal (h1)" : `${facts.h1.length} títulos principais (h1): a hierarquia fica confusa`);
    if (facts.h2.length >= 2) {
      score += 2;
      bits.push(`${facts.h2.length} seções com subtítulo (h2)`);
    } else bits.push(`${facts.h2.length} subtítulo(s) (h2)`);
    const h1len = facts.h1[0]?.length ?? 0;
    if (h1len >= 8 && h1len <= 90) score += 1;
    rubric.push({ key: "hierarquia", label: "Hierarquia da página", score: clamp(score), evidence: bits.join("; ") });
  }

  // 3) Clareza da oferta
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.title) score += 1;
    else bits.push("sem título da página");
    if ((facts.description?.length ?? 0) >= 50) {
      score += 1;
      bits.push("tem descrição para o Google");
    } else bits.push("sem descrição para o Google");
    const keys = [hints.segment, hints.companyName].filter(Boolean).map((s) => normalizeKey(String(s)));
    const head = normalizeKey([facts.title, ...facts.h1].filter(Boolean).join(" "));
    const mentions = keys.some((k) => k.length >= 4 && head.includes(k.split(" ")[0]!));
    if (mentions) {
      score += 1;
      bits.push("o topo da página diz quem é a empresa ou o que ela faz");
    } else bits.push("o topo da página não deixa claro quem é a empresa ou o que ela faz");
    if (facts.wordCount >= 150) score += 1;
    else bits.push(`pouco texto (${facts.wordCount} palavras)`);
    if (facts.prices.length > 0 || facts.h2.length >= 3) score += 1;
    rubric.push({ key: "oferta", label: "Clareza da oferta", score: clamp(score), evidence: bits.length > 0 ? bits.join("; ") : "título, descrição e texto presentes" });
  }

  // 4) Prova social
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.socialProof.length > 0) {
      score += 3;
      bits.push(`menciona prova social ("${facts.socialProof[0]}")`);
    } else bits.push("nenhum depoimento, avaliação ou portfólio encontrado");
    if (facts.links.instagram || facts.links.facebook) {
      score += 1;
      bits.push("liga às redes sociais");
    }
    if (facts.links.maps) score += 1;
    rubric.push({ key: "prova_social", label: "Prova social", score: clamp(score), evidence: bits.join("; ") });
  }

  // 5) Chamada para ação e contato
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.ctas.length > 0) {
      score += 2;
      bits.push(`chamada para ação ("${facts.ctas[0]}")`);
    } else bits.push("nenhuma chamada para ação clara");
    if (facts.whatsapp || facts.phones.length > 0) {
      score += 2;
      bits.push(facts.whatsapp ? "WhatsApp visível" : `telefone visível (${facts.phones[0]})`);
    } else bits.push("sem telefone nem WhatsApp visível");
    if (facts.hasForm || facts.email) score += 1;
    rubric.push({ key: "cta", label: "Chamada para ação e contato", score: clamp(score), evidence: bits.join("; ") });
  }

  // 6) Atualização técnica
  {
    let score = 0;
    const bits: string[] = [];
    if (facts.https) score += 1;
    else bits.push("sem HTTPS (o navegador avisa que o site não é seguro)");
    if (facts.outdatedSignals.length === 0) score += 2;
    else bits.push(`sinais de site antigo: ${facts.outdatedSignals.join("; ")}`);
    if (!facts.copyrightYear || facts.copyrightYear >= currentYear - 2) score += 1;
    if (!facts.cheapBuilder) score += 1;
    else bits.push("hospedado em construtor gratuito");
    rubric.push({ key: "tecnica", label: "Atualização técnica", score: clamp(score), evidence: bits.length > 0 ? bits.join("; ") : "HTTPS, sem sinais de site antigo" });
  }

  const total = Math.round((rubric.reduce((n, r) => n + r.score, 0) / (rubric.length * 5)) * 100);
  const reasons: string[] = [];
  if (facts.parked) reasons.push("a página é um domínio à venda ou estacionado");
  if (facts.underConstruction) reasons.push("a página está “em construção”");
  if (facts.cheapBuilder) reasons.push("o site está em um construtor gratuito");
  if (!facts.hasViewport) reasons.push("não se adapta ao celular (sem a tag viewport)");
  if (facts.copyrightYear && facts.copyrightYear <= currentYear - 3) reasons.push(`rodapé parado em ${facts.copyrightYear}`);
  for (const r of [...rubric].sort((a, b) => a.score - b.score).slice(0, 3)) {
    if (r.score <= 2) reasons.push(`${r.label.toLowerCase()}: ${r.evidence}`);
  }

  let label: SiteAssessment["label"] = total >= 70 ? "bom" : total >= 45 ? "desatualizado" : "ruim";
  if (facts.parked || facts.underConstruction || facts.cheapBuilder) label = "ruim";
  else if (label === "bom" && (!facts.hasViewport || (facts.copyrightYear !== null && facts.copyrightYear <= currentYear - 3))) label = "desatualizado";

  return { method: "regras", rubric, total, label, reasons: [...new Set(reasons)].slice(0, 6), screenshots: [] };
}

function normalizeKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Perfis públicos (redes, canal, lojas)                               */
/* ------------------------------------------------------------------ */

export interface ProfileFacts {
  blocked: boolean;
  /** Por que foi considerado bloqueado. */
  blockReason: string | null;
  title: string | null;
  description: string | null;
  followers: string | null;
  posts: string | null;
}

const CHALLENGE_RE = /(just a moment|cf-chl|attention required|captcha|access denied|verifique que voc[eê] [eé] humano|are you a robot|unusual traffic)/i;

/**
 * Lê só o que o perfil publica sem login (título e descrição da pré-visualização).
 * Login, desafio anti-robô, 403 e 429 viram "bloqueada": a fonte não é contornada.
 */
export function parseProfile(html: string, status: number | null, finalUrl: string): ProfileFacts {
  const base = { title: null, description: null, followers: null, posts: null };
  if (status === 401 || status === 403 || status === 429 || status === 503) {
    return { blocked: true, blockReason: `a fonte respondeu HTTP ${status} (acesso barrado)`, ...base };
  }
  if (/\/(accounts\/)?login\b|\/checkpoint\b|\/privacy\/consent/i.test(finalUrl)) {
    return { blocked: true, blockReason: "a fonte pediu login para mostrar o perfil", ...base };
  }
  if (CHALLENGE_RE.test(html.slice(0, 20_000))) {
    return { blocked: true, blockReason: "a fonte exibiu um desafio anti-robô (não é contornado)", ...base };
  }
  const title = metaContent(html, "og:title") ?? allMatches(html, /<title[^>]*>([\s\S]*?)<\/title>/i, 1, 1)[0] ?? null;
  const description = metaContent(html, "og:description") ?? metaContent(html, "description");
  if (!title || /^(instagram|facebook|log in|entrar|login)\b/i.test(title) || !description) {
    return { blocked: true, blockReason: "a fonte não mostra o perfil sem login", ...base };
  }
  const followers = /([\d.,]+\s?[KkMm]?)\s*(?:Followers|seguidores|curtidas|likes)/i.exec(description)?.[1]?.trim() ?? null;
  const posts = /([\d.,]+\s?[KkMm]?)\s*(?:Posts|publica[cç][õo]es)/i.exec(description)?.[1]?.trim() ?? null;
  return { blocked: false, blockReason: null, title: cleanText(title, 120), description: cleanText(description, 220), followers, posts };
}
