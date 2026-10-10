import { UI, intlDigits } from "@/lib/site-generate";
import type { DossierProfile, SiteCheck } from "@/types/agents";

/**
 * Verificação estática da prévia — independente do gerador.
 *
 * Lê só o HTML pronto e confere o que a regra do projeto exige: nada de
 * conteúdo que o dossiê não comprove, nenhum recurso externo, nenhum link fora
 * da lista permitida, contatos idênticos aos do perfil e a página fora dos
 * buscadores. Se qualquer verificação falhar, a prévia não é entregue.
 */

const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export const words = (s: string): string[] => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Cada trecho de texto visível da página (inclusive título, descrição e rótulos de acessibilidade). */
export function textNodes(html: string): string[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
  const nodes = body
    .split(/<[^>]*>/)
    .map((t) => decode(t).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const m of body.matchAll(/\b(?:aria-label|title|alt)=["']([^"']*)["']/gi)) nodes.push(decode(m[1]!).trim());
  const desc = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(body);
  if (desc) nodes.push(decode(desc[1]!).trim());
  return nodes.filter(Boolean);
}

/** Palavras que podem aparecer: as do perfil comprovado e as do vocabulário fixo da interface. */
export function allowedWords(profile: DossierProfile): Set<string> {
  const values = [
    profile.name,
    profile.segment,
    profile.city,
    profile.tagline,
    profile.description,
    ...profile.headings,
    profile.whatsapp,
    profile.phone,
    profile.email,
    profile.address,
    profile.hours,
    profile.rating !== null ? String(profile.rating).replace(".", ",") : null,
    profile.rating !== null ? String(profile.rating) : null,
    profile.reviews !== null ? String(profile.reviews) : null,
    ...Object.values(UI),
  ];
  const out = new Set<string>();
  for (const v of values) if (v) for (const w of words(v)) out.add(w);
  return out;
}

/** Endereços externos que a página pode ter, todos derivados do perfil. */
export function allowedExternalHrefs(profile: DossierProfile): string[] {
  const out: string[] = [];
  if (profile.whatsapp) out.push(`https://wa.me/${intlDigits(profile.whatsapp)}`);
  if (profile.phone) out.push(`tel:+${intlDigits(profile.phone)}`);
  if (profile.email) out.push(`mailto:${profile.email}`);
  const handle = (v: string | null) => v?.replace(/^@/, "").replace(/^.*\.com\//, "").replace(/[^A-Za-z0-9._-]/g, "") ?? "";
  if (handle(profile.instagram)) out.push(`https://www.instagram.com/${handle(profile.instagram)}/`);
  if (handle(profile.facebook)) out.push(`https://www.facebook.com/${handle(profile.facebook)}`);
  if (profile.youtube && /^https:\/\//i.test(profile.youtube)) out.push(profile.youtube);
  if (profile.maps_url && /^https:\/\//i.test(profile.maps_url)) out.push(profile.maps_url);
  return out;
}

const check = (name: string, ok: boolean, detail: string): SiteCheck => ({ name, ok, detail });

export function verifySiteStatic(html: string, profile: DossierProfile): SiteCheck[] {
  const checks: SiteCheck[] = [];

  /* 1. Fora dos buscadores */
  const noindex = /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(html);
  checks.push(check("fora dos buscadores", noindex, noindex ? "A página pede noindex, nofollow." : "Falta <meta name=\"robots\" content=\"noindex\">."));

  /* 2. Sem código ativo nem recursos de terceiros.
   * As marcas são procuradas só na estrutura (sem o texto entre as tags nem o valor dos atributos):
   * um texto que MENCIONE "src=" ou "onerror=" aparece escapado e não é uma marca. */
  const styles = (html.match(/<style[\s\S]*?<\/style>/gi) ?? []).join("\n");
  const markup = html
    .replace(/<style[\s\S]*?<\/style>/gi, "<style></style>")
    .replace(/="[^"]*"|='[^']*'/g, '=""')
    .replace(/>[^<]*</g, "><");
  const banned: string[] = [];
  for (const [re, label, target] of [
    [/<script\b/i, "script", markup],
    [/<iframe\b/i, "iframe", markup],
    [/<form\b/i, "formulário", markup],
    [/<object\b|<embed\b/i, "objeto embutido", markup],
    [/<video\b|<audio\b/i, "mídia", markup],
    [/<link\b/i, "folha de estilo externa", markup],
    [/\ssrc\s*=/i, "recurso com src", markup],
    [/\son[a-z]+\s*=/i, "manipulador de evento embutido", markup],
    [/@import|url\(\s*["']?(?:https?:)?\/\//i, "recurso externo no CSS", styles + (html.match(/\sstyle=["'][^"']*["']/gi) ?? []).join("\n")],
  ] as Array<[RegExp, string, string]>) {
    if (re.test(target)) banned.push(label);
  }
  checks.push(check("sem recursos externos nem scripts", banned.length === 0, banned.length === 0 ? "Só HTML e CSS dentro da própria página." : `Encontrado: ${banned.join(", ")}.`));

  /* 3. Sem imagens (nada de foto que não seja do cliente) */
  const imgs = (markup.match(/<img\b/gi) ?? []).length;
  checks.push(check("sem imagens inventadas", imgs === 0, imgs === 0 ? "A página não usa imagens: só tipografia e cor." : `${imgs} imagem(ns) na página.`));

  /* 4. Links permitidos */
  const hrefs = [...html.matchAll(/\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => decode(m[1]!));
  const ids = new Set([...html.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!));
  const allowed = new Set(allowedExternalHrefs(profile));
  const badLinks = hrefs.filter((h) => (h.startsWith("#") ? !ids.has(h.slice(1)) : !allowed.has(h)));
  checks.push(check("links permitidos", badLinks.length === 0, badLinks.length === 0 ? `${hrefs.length} link(s), todos internos ou vindos do dossiê.` : `Link(s) fora da lista: ${badLinks.slice(0, 3).join(", ")}.`));

  /* 5. Todo texto vem do dossiê ou da interface */
  const ok = allowedWords(profile);
  const foreign = new Set<string>();
  for (const node of textNodes(html)) for (const w of words(node)) if (!ok.has(w)) foreign.add(w);
  checks.push(check("texto só do dossiê", foreign.size === 0, foreign.size === 0 ? "Toda palavra da página está no dossiê ou no vocabulário da interface." : `Palavras fora do dossiê: ${[...foreign].slice(0, 6).join(", ")}.`));

  /* 6. Contatos idênticos aos do perfil */
  const missing: string[] = [];
  const text = textNodes(html).join(" | ");
  for (const [label, value] of [["WhatsApp", profile.whatsapp], ["telefone", profile.phone], ["e-mail", profile.email], ["endereço", profile.address]] as const) {
    if (value && !text.includes(value)) missing.push(label);
  }
  const emailsInPage = [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
  const strangeEmail = emailsInPage.filter((e) => e !== profile.email?.toLowerCase());
  checks.push(
    check("contatos fiéis ao dossiê", missing.length === 0 && strangeEmail.length === 0, missing.length === 0 && strangeEmail.length === 0 ? "Telefone, WhatsApp, e-mail e endereço batem com o dossiê." : [missing.length ? `faltam: ${missing.join(", ")}` : "", strangeEmail.length ? `e-mail estranho: ${strangeEmail[0]}` : ""].filter(Boolean).join("; "))
  );

  /* 7. Página com título e idioma */
  const titled = /<title>[^<]+<\/title>/i.test(html) && /<html[^>]+lang=["']pt-BR["']/i.test(html);
  checks.push(check("título e idioma", titled, titled ? "Título da página e idioma pt-BR definidos." : "Falta o título ou o idioma."));

  return checks;
}
