import type { DossierProfile } from "@/types/agents";

/**
 * Gerador da prévia do site: do perfil comprovado pelo dossiê a uma página
 * estática (HTML + CSS inline, sem script, sem recurso externo, sem imagem).
 *
 * É código determinístico, não um modelo: cada texto da página é um valor do
 * perfil ou uma palavra do vocabulário fixo da interface (`UI`). Nada de
 * depoimento, preço, endereço ou número inventado, e nada de foto de banco
 * apresentada como do cliente — a página usa tipografia e cor, não imagens.
 * `verifySiteStatic` (verify.ts) confere o resultado de forma independente.
 */

/** Vocabulário fixo da interface do site. Só estas frases existem além dos dados do cliente. */
export const UI = {
  nav_about: "Sobre",
  nav_services: "Serviços",
  nav_label: "Principal",
  nav_reviews: "Avaliações",
  nav_contact: "Contato",
  skip: "Ir para o conteúdo",
  cta_whatsapp: "Falar pelo WhatsApp",
  cta_call: "Ligar agora",
  cta_email: "Enviar e-mail",
  about_title: "Sobre",
  services_title: "Serviços",
  services_lead: "O que você encontra por aqui",
  reviews_title: "Avaliações",
  reviews_label: "Avaliação no Google",
  reviews_count: "avaliações",
  reviews_note: "Nota e quantidade vêm da ficha da empresa no Google Maps.",
  contact_title: "Contato",
  contact_lead: "Fale com a gente",
  address: "Endereço",
  hours: "Horário",
  phone: "Telefone",
  whatsapp: "WhatsApp",
  email: "E-mail",
  maps: "Ver no mapa",
  social: "Redes",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  preview_banner: "Prévia criada para apresentação. Ainda não foi publicada.",
  footer: "Prévia de site para",
  all_rights: "Todos os direitos reservados",
} as const;

export interface GeneratedSite {
  html: string;
  /** Âncoras internas que a página define (conferidas pela verificação). */
  anchors: string[];
  /** Links externos que a página contém (todos vêm do perfil). */
  externalLinks: string[];
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Títulos de seção do site antigo que não são serviços. */
const NOT_A_SERVICE = /(contato|fale|quem somos|sobre|depoimento|cliente|blog|newsletter|onde estamos|localiza|hor[aá]rio|menu|rede|siga|pol[ií]tica|termo|carrinho|login|entrar|cadastr|busca|pesquis|copyright|todos os direitos|avalia|portf[oó]lio|equipe|trabalhe)/i;

export function serviceHeadings(headings: string[]): string[] {
  const out: string[] = [];
  for (const h of headings) {
    const t = h.trim();
    if (t.length < 3 || t.length > 70 || NOT_A_SERVICE.test(t)) continue;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/* ---------------------------- cores ---------------------------- */

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s * Math.min(l, 1 - l)) / 1;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function normalizeHex(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Cor principal: a do site atual (se for legível) ou um tom derivado do nome. Sempre com contraste suficiente. */
export function pickPalette(profile: DossierProfile): { primary: string; onPrimary: string; soft: string } {
  let primary = normalizeHex(profile.theme_color) ?? hslToHex(hashHue(profile.name), 0.55, 0.36);
  // Cor muito clara não segura texto branco nem destaque: escurece até ter contraste.
  if (luminance(primary) > 0.45) primary = hslToHex(hashHue(profile.name), 0.55, 0.34);
  const onPrimary = luminance(primary) > 0.4 ? "#111111" : "#ffffff";
  const soft = hslToHex(hashHue(profile.name), 0.4, 0.95);
  return { primary, onPrimary, soft };
}

/* ---------------------------- contatos ---------------------------- */

const digits = (s: string) => s.replace(/\D/g, "");

/** Número em formato internacional só com dígitos (Brasil: acrescenta 55 quando falta). */
export function intlDigits(raw: string): string {
  const d = digits(raw);
  return d.startsWith("55") && d.length >= 12 ? d : `55${d.replace(/^0+/, "")}`;
}

const httpsUrl = (u: string | null): string | null => (u && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

function socialUrl(kind: "instagram" | "facebook", value: string | null): string | null {
  if (!value) return null;
  const handle = value.replace(/^@/, "").replace(/^.*\.com\//, "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!handle) return null;
  return kind === "instagram" ? `https://www.instagram.com/${handle}/` : `https://www.facebook.com/${handle}`;
}

/* ---------------------------- página ---------------------------- */

export function generateSite(profile: DossierProfile): GeneratedSite {
  const { primary, onPrimary, soft } = pickPalette(profile);
  const services = serviceHeadings(profile.headings);
  const externalLinks: string[] = [];
  const anchors = ["conteudo", "topo"];

  const wa = profile.whatsapp ? `https://wa.me/${intlDigits(profile.whatsapp)}` : null;
  const phone = profile.phone ? `tel:+${intlDigits(profile.phone)}` : null;
  const mail = profile.email ? `mailto:${profile.email}` : null;
  const ig = socialUrl("instagram", profile.instagram);
  const fb = socialUrl("facebook", profile.facebook);
  const yt = httpsUrl(profile.youtube);
  const maps = httpsUrl(profile.maps_url);
  for (const l of [wa, ig, fb, yt, maps]) if (l) externalLinks.push(l);

  const where = [profile.segment, profile.city].filter(Boolean).join(" · ");
  const tagline = profile.tagline && profile.tagline.toLowerCase() !== profile.name.toLowerCase() ? profile.tagline : where || null;
  const hasAbout = Boolean(profile.description);
  const hasReviews = profile.rating !== null && profile.reviews !== null;
  const rating = profile.rating !== null ? String(profile.rating).replace(".", ",") : "";

  const nav: Array<[string, string]> = [];
  if (hasAbout) nav.push(["sobre", UI.nav_about]);
  if (services.length > 0) nav.push(["servicos", UI.nav_services]);
  if (hasReviews) nav.push(["avaliacoes", UI.nav_reviews]);
  nav.push(["contato", UI.nav_contact]);
  for (const [id] of nav) anchors.push(id);

  const cta = wa
    ? `<a class="btn" href="${esc(wa)}" rel="noopener noreferrer">${UI.cta_whatsapp}</a>`
    : phone
      ? `<a class="btn" href="${esc(phone)}">${UI.cta_call}</a>`
      : mail
        ? `<a class="btn" href="${esc(mail)}">${UI.cta_email}</a>`
        : "";

  const contactRows: string[] = [];
  if (profile.address) contactRows.push(`<div><dt>${UI.address}</dt><dd>${esc(profile.address)}${maps ? ` <a href="${esc(maps)}" rel="noopener noreferrer">${UI.maps}</a>` : ""}</dd></div>`);
  if (profile.hours) contactRows.push(`<div><dt>${UI.hours}</dt><dd>${esc(profile.hours)}</dd></div>`);
  if (profile.phone) contactRows.push(`<div><dt>${UI.phone}</dt><dd><a href="${esc(phone!)}">${esc(profile.phone)}</a></dd></div>`);
  if (profile.whatsapp) contactRows.push(`<div><dt>${UI.whatsapp}</dt><dd><a href="${esc(wa!)}" rel="noopener noreferrer">${esc(profile.whatsapp)}</a></dd></div>`);
  if (profile.email) contactRows.push(`<div><dt>${UI.email}</dt><dd><a href="${esc(mail!)}">${esc(profile.email)}</a></dd></div>`);
  const socials = [ig && `<a href="${esc(ig)}" rel="noopener noreferrer">${UI.instagram}</a>`, fb && `<a href="${esc(fb)}" rel="noopener noreferrer">${UI.facebook}</a>`, yt && `<a href="${esc(yt)}" rel="noopener noreferrer">${UI.youtube}</a>`].filter(Boolean);
  if (socials.length > 0) contactRows.push(`<div><dt>${UI.social}</dt><dd class="social">${socials.join(" ")}</dd></div>`);

  const description = profile.description ? esc(profile.description.slice(0, 300)) : esc(tagline ?? profile.name);

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(profile.name)}</title>
<meta name="description" content="${description}">
<style>
:root{--primary:${primary};--on-primary:${onPrimary};--soft:${soft};--ink:#1b1f23;--muted:#4a5560;--line:#dfe4e8;--bg:#ffffff}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6;font-size:17px}
a{color:var(--primary)}
.skip{position:absolute;left:-999px;top:0;background:#fff;color:#000;padding:.6rem 1rem;z-index:10}
.skip:focus{left:0}
.banner{background:#111;color:#fff;text-align:center;font-size:.82rem;padding:.45rem 1rem}
header.top{position:sticky;top:0;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);z-index:5}
.bar{max-width:68rem;margin:0 auto;padding:.7rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.brand{font-weight:700;font-size:1.05rem;text-decoration:none;color:var(--ink)}
nav ul{list-style:none;display:flex;gap:1.1rem;margin:0;padding:0;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;font-size:.95rem}
nav a:hover,nav a:focus{color:var(--primary);text-decoration:underline}
.hero{background:var(--primary);color:var(--on-primary);padding:4.5rem 1.25rem 4rem}
.hero .in{max-width:68rem;margin:0 auto}
.hero h1{font-size:clamp(2rem,6vw,3.4rem);line-height:1.12;margin:0 0 .8rem;letter-spacing:-.02em;overflow-wrap:anywhere}
.hero p{font-size:1.15rem;max-width:40rem;margin:0 0 1.6rem;opacity:.95}
.btn{display:inline-block;background:var(--on-primary);color:var(--primary);font-weight:700;text-decoration:none;padding:.85rem 1.5rem;border-radius:.6rem;border:2px solid var(--on-primary)}
.btn:hover,.btn:focus{background:transparent;color:var(--on-primary)}
main section{max-width:68rem;margin:0 auto;padding:3.2rem 1.25rem}
h2{font-size:1.7rem;margin:0 0 1rem;letter-spacing:-.01em}
.lead{color:var(--muted);margin:0 0 1.4rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem;list-style:none;margin:0;padding:0}
.cards li{background:var(--soft);border-left:4px solid var(--primary);border-radius:.5rem;padding:1.1rem 1.2rem;font-weight:600;overflow-wrap:anywhere}
.rating{display:flex;align-items:baseline;gap:.8rem;flex-wrap:wrap}
.rating strong{font-size:3rem;line-height:1;color:var(--primary)}
.note{font-size:.88rem;color:var(--muted)}
dl{margin:0;display:grid;gap:.9rem}
dt{font-weight:700;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
.social{display:flex;gap:1rem;flex-wrap:wrap}
footer{border-top:1px solid var(--line);padding:1.6rem 1.25rem;text-align:center;color:var(--muted);font-size:.9rem}
@media (max-width:600px){body{font-size:16px}.hero{padding:3rem 1.25rem 2.6rem}.bar{padding:.6rem 1rem}}
</style>
</head>
<body id="topo">
<a class="skip" href="#conteudo">${UI.skip}</a>
<div class="banner" role="note">${UI.preview_banner}</div>
<header class="top"><div class="bar"><a class="brand" href="#topo">${esc(profile.name)}</a><nav aria-label="${UI.nav_label}"><ul>${nav.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("")}</ul></nav></div></header>
<section class="hero"><div class="in"><h1>${esc(profile.name)}</h1>${tagline ? `<p>${esc(tagline)}</p>` : ""}${cta}</div></section>
<main id="conteudo">
${hasAbout ? `<section id="sobre"><h2>${UI.about_title}</h2><p>${esc(profile.description!)}</p></section>` : ""}
${services.length > 0 ? `<section id="servicos"><h2>${UI.services_title}</h2><p class="lead">${UI.services_lead}</p><ul class="cards">${services.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></section>` : ""}
${hasReviews ? `<section id="avaliacoes"><h2>${UI.reviews_title}</h2><div class="rating"><strong>${esc(rating)}</strong><span>${UI.reviews_label} · ${esc(String(profile.reviews))} ${UI.reviews_count}</span></div><p class="note">${UI.reviews_note}</p></section>` : ""}
<section id="contato"><h2>${UI.contact_title}</h2><p class="lead">${UI.contact_lead}</p><dl>${contactRows.join("")}</dl>${cta ? `<p style="margin-top:1.6rem">${cta.replace('class="btn"', 'class="btn" style="background:var(--primary);color:var(--on-primary);border-color:var(--primary)"')}</p>` : ""}</section>
</main>
<footer>${UI.footer} ${esc(profile.name)} · ${UI.all_rights}</footer>
</body>
</html>
`;
  return { html, anchors, externalLinks };
}
