import { assessSite, cleanText, isLinkBioUrl, parseProfile, parseSite, type SiteFacts } from "@/services/presence/parse";
import type { Lead } from "@/types";
import type { DossierEvidence, DossierFinding, DossierFindingKind, DossierSource, DossierSourceKey, DossierSourceStatus, SiteAssessment } from "@/types/agents";

/**
 * Coleta das fontes públicas e montagem das afirmações do dossiê.
 *
 * Regra de ouro: **nenhuma afirmação entra sem evidência**. `FindingSink.add`
 * descarta o que vier sem trecho de origem, e `validateDossier` confere o
 * resultado inteiro. Fonte barrada vira "bloqueada" (e baixa a confiança); não
 * há tentativa de contornar login, desafio anti-robô nem limite de requisições.
 * O texto das páginas é dado: nunca decide o que o agente faz.
 */

export interface PageResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
  error: string | null;
}

export type PageFetcher = (url: string) => Promise<PageResult>;

export interface GatherOptions {
  fetchPage: PageFetcher;
  now?: Date;
  /** Espera entre requisições a hosts diferentes. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GatherResult {
  sources: DossierSource[];
  findings: DossierFinding[];
  facts: SiteFacts | null;
  assessment: SiteAssessment | null;
  /** O resultado do site foi uma leitura completa (autoriza atualizar `website_quality`). */
  siteVerdict: boolean;
}

const SOURCE_LABEL: Record<DossierSourceKey, string> = {
  site: "Site atual",
  google_maps: "Google Maps",
  instagram: "Instagram",
  facebook: "Facebook",
  link_bio: "Link na bio",
  youtube: "YouTube",
  mercadolivre: "Mercado Livre",
  olx: "OLX",
};

export const SOURCE_ORDER: DossierSourceKey[] = ["site", "google_maps", "instagram", "facebook", "link_bio", "youtube", "mercadolivre", "olx"];

/** Leads de demonstração têm domínios e perfis inexistentes: nada é consultado. */
export function isSyntheticLead(lead: Pick<Lead, "source">): boolean {
  return lead.source === "demo" || lead.source === "diretorio";
}

class FindingSink {
  readonly findings: DossierFinding[] = [];
  add(kind: DossierFindingKind, claim: string, evidence: DossierEvidence[]) {
    const proof = evidence.filter((e) => e.excerpt.trim().length > 0);
    if (proof.length === 0) return; // sem evidência, sem afirmação
    this.findings.push({ id: `f${this.findings.length + 1}`, kind, claim: cleanText(claim, 240), evidence: proof.map((e) => ({ ...e, excerpt: cleanText(e.excerpt, 200) })) });
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const dateLabel = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

export async function gatherSources(lead: Lead, opts: GatherOptions): Promise<GatherResult> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sink = new FindingSink();
  const sources = new Map<DossierSourceKey, DossierSource>();
  const stamp = now.toISOString();

  const setSource = (key: DossierSourceKey, status: DossierSourceStatus, url: string | null, note: string | null, fetched = false) => {
    sources.set(key, { key, label: SOURCE_LABEL[key], status, url, fetched_at: fetched ? stamp : null, note });
  };
  for (const key of SOURCE_ORDER) setSource(key, "pendente", null, null);

  // Demonstração: nada de rede.
  if (isSyntheticLead(lead)) {
    for (const key of SOURCE_ORDER) setSource(key, "pendente", null, "Lead de demonstração: os endereços não existem de verdade, então nada é consultado.");
    return { sources: SOURCE_ORDER.map((k) => sources.get(k)!), findings: [], facts: null, assessment: null, siteVerdict: false };
  }

  let firstFetch = true;
  const fetchPage = async (url: string): Promise<PageResult> => {
    if (!firstFetch && (opts.delayMs ?? 0) > 0) await sleep(opts.delayMs!);
    firstFetch = false;
    return opts.fetchPage(url);
  };

  /* ------------------------------ Google Maps ------------------------------ */
  const mapsUrl = lead.google_maps_url ?? null;
  if (lead.source === "google_places" && (lead.rating || lead.reviews_count || lead.address)) {
    setSource("google_maps", "concluida", mapsUrl, null);
    const bits = [lead.rating ? `nota ${lead.rating}` : null, lead.reviews_count ? `${lead.reviews_count} avaliações` : null].filter(Boolean).join(" · ");
    if (bits) sink.add("destaque", `Reputação no Google Maps: ${bits}.`, [{ source: "google_maps", url: mapsUrl, excerpt: `Ficha do Google Maps: ${bits}` }]);
    if (lead.address) sink.add("contato", "Endereço público na ficha do Google Maps.", [{ source: "google_maps", url: mapsUrl, excerpt: `Endereço: ${lead.address}` }]);
    if (lead.opening_hours) sink.add("contato", "Horário de funcionamento na ficha do Google Maps.", [{ source: "google_maps", url: mapsUrl, excerpt: `Horário: ${lead.opening_hours}` }]);
  } else {
    setSource("google_maps", "pendente", mapsUrl, "O lead não veio do Google Maps: não há ficha para consultar.");
  }

  /* --------------------------------- Site --------------------------------- */
  let facts: SiteFacts | null = null;
  let assessment: SiteAssessment | null = null;
  let siteVerdict = false;
  const website = lead.website ?? null;

  if (!website) {
    setSource("site", "concluida", null, "O cadastro do lead não informa site.");
    const viaMaps = lead.source === "google_places" && sources.get("google_maps")?.status === "concluida";
    sink.add(
      "lacuna",
      "A empresa não tem site informado.",
      [viaMaps ? { source: "google_maps", url: mapsUrl, excerpt: "A ficha do Google Maps não traz endereço de site" } : { source: "site", url: null, excerpt: "Nenhum site no cadastro do lead" }]
    );
  } else {
    const page = await fetchPage(website);
    const blocked = page.status === 401 || page.status === 403 || page.status === 429;
    if (page.ok && page.body) {
      facts = parseSite(page.body, page.finalUrl, { companyName: lead.company_name });
      assessment = assessSite(facts, { segment: lead.segment, companyName: lead.company_name }, now);
      siteVerdict = true;
      setSource("site", page.truncated ? "parcial" : "concluida", page.finalUrl, page.truncated ? "A página é muito grande; só o começo foi lido." : null, true);
      describeSite(sink, facts, assessment, page.finalUrl, lead);
    } else if (blocked) {
      setSource("site", "bloqueada", website, `O site respondeu HTTP ${page.status} (acesso barrado): não foi possível avaliá-lo.`, true);
    } else if (page.status !== null && (page.status === 404 || page.status === 410 || page.status >= 500)) {
      setSource("site", "concluida", website, `O site respondeu HTTP ${page.status}.`, true);
      siteVerdict = true;
      assessment = { method: "regras", rubric: [], total: 0, label: "ruim", reasons: [`o site não abre (HTTP ${page.status})`], screenshots: [] };
      sink.add("problema", `O site cadastrado não abre (HTTP ${page.status}).`, [{ source: "site", url: website, excerpt: `Resposta HTTP ${page.status} em ${dateLabel(now)}` }]);
    } else {
      setSource("site", "parcial", website, page.error ? `Não foi possível ler o site: ${page.error}.` : "Não foi possível ler o site agora.", true);
    }
  }

  /* ----------------------- Redes e outras fontes públicas ----------------------- */
  const handle = (lead.instagram ?? facts?.links.instagram ?? "").replace(/^@/, "").trim();
  await profileSource({
    key: "instagram",
    url: handle ? `https://www.instagram.com/${encodeURIComponent(handle)}/` : null,
    label: handle ? `@${handle}` : "",
    declared: Boolean(lead.instagram),
    sink,
    sources,
    setSource,
    fetchPage,
    lead,
    kind: "presenca",
    describe: (p, l) => {
      const counts = [p.followers ? `${p.followers} seguidores` : null, p.posts ? `${p.posts} publicações` : null].filter(Boolean).join(" e ");
      return {
        claim: counts ? `Instagram ${l} ativo, com ${counts}.` : `Instagram ${l} tem perfil público.`,
        excerpt: p.description ?? p.title ?? "",
      };
    },
  });

  const fbSlug = (lead.facebook ?? facts?.links.facebook ?? "").replace(/^.*facebook\.com\//, "").replace(/\/.*$/, "").trim();
  await profileSource({
    key: "facebook",
    url: fbSlug ? `https://www.facebook.com/${encodeURIComponent(fbSlug)}` : null,
    label: fbSlug,
    declared: Boolean(lead.facebook),
    sink,
    sources,
    setSource,
    fetchPage,
    lead,
    kind: "presenca",
    describe: (p, l) => ({ claim: `Página no Facebook (${l}): ${p.title ?? "perfil público"}.`, excerpt: p.description ?? p.title ?? "" }),
  });

  /* Link na bio: o próprio site é um agregador, ou o site aponta para um. */
  const bioUrl = isLinkBioUrl(website) ? (facts?.url ?? website) : (facts?.links.linkBio[0] ?? null);
  if (!bioUrl) {
    setSource("link_bio", "pendente", null, "Nenhum link na bio conhecido (o site não aponta para um agregador).");
  } else {
    const page = bioUrl === facts?.url ? null : await fetchPage(bioUrl);
    const html = page ? page.body : null;
    const bioFacts = page ? (page.ok && html ? parseSite(html, page.finalUrl) : null) : facts;
    if (page && !page.ok && (page.status === 403 || page.status === 429)) {
      setSource("link_bio", "bloqueada", bioUrl, `O agregador respondeu HTTP ${page.status}.`, true);
    } else if (!bioFacts) {
      setSource("link_bio", "parcial", bioUrl, "Não foi possível ler o link na bio.", true);
    } else {
      const hosts = new Set<string>();
      const src = page ? (page.body ?? "") : "";
      for (const m of src.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) hosts.add(hostOf(m[1]!));
      for (const l of [bioFacts.links.instagram && "instagram.com", bioFacts.whatsapp && "wa.me", bioFacts.links.mercadolivre[0] && "mercadolivre.com.br", bioFacts.links.olx[0] && "olx.com.br"]) if (l) hosts.add(l);
      const list = [...hosts].filter((h) => !isLinkBioUrl(`https://${h}`)).slice(0, 8);
      setSource("link_bio", "concluida", bioUrl, null, true);
      if (list.length > 0) sink.add("presenca", `O link na bio reúne ${list.length} destino(s): ${list.join(", ")}.`, [{ source: "link_bio", url: bioUrl, excerpt: `Links encontrados: ${list.join(", ")}` }]);
    }
  }

  await profileSource({
    key: "youtube",
    url: facts?.links.youtube[0] ?? null,
    label: "",
    declared: false,
    sink,
    sources,
    setSource,
    fetchPage,
    lead,
    kind: "destaque",
    describe: (p) => ({ claim: `Canal no YouTube: ${p.title ?? "canal público"}.`, excerpt: p.description ?? p.title ?? "" }),
    missingNote: "O site não aponta para um canal do YouTube.",
  });
  await profileSource({
    key: "mercadolivre",
    url: facts?.links.mercadolivre[0] ?? null,
    label: "",
    declared: false,
    sink,
    sources,
    setSource,
    fetchPage,
    lead,
    kind: "presenca",
    describe: (p) => ({ claim: `Vende no Mercado Livre: ${p.title ?? "loja pública"}.`, excerpt: p.description ?? p.title ?? "" }),
    missingNote: "O site não aponta para uma loja no Mercado Livre (a API pública não identifica o vendedor com segurança, então não se procura por nome).",
  });
  await profileSource({
    key: "olx",
    url: facts?.links.olx[0] ?? null,
    label: "",
    declared: false,
    sink,
    sources,
    setSource,
    fetchPage,
    lead,
    kind: "presenca",
    describe: (p) => ({ claim: `Anuncia na OLX: ${p.title ?? "anúncio público"}.`, excerpt: p.description ?? p.title ?? "" }),
    missingNote: "O site não aponta para um anúncio na OLX.",
  });

  return { sources: SOURCE_ORDER.map((k) => sources.get(k)!), findings: sink.findings, facts, assessment, siteVerdict };
}

interface ProfileJob {
  key: DossierSourceKey;
  url: string | null;
  label: string;
  /** O endereço veio do cadastro do lead (e não de um achado no site). */
  declared: boolean;
  sink: FindingSink;
  sources: Map<DossierSourceKey, DossierSource>;
  setSource: (key: DossierSourceKey, status: DossierSourceStatus, url: string | null, note: string | null, fetched?: boolean) => void;
  fetchPage: PageFetcher;
  lead: Lead;
  kind: DossierFindingKind;
  describe: (p: ReturnType<typeof parseProfile>, label: string) => { claim: string; excerpt: string };
  missingNote?: string;
}

async function profileSource(job: ProfileJob): Promise<void> {
  const { key, url, setSource } = job;
  if (!url) {
    setSource(key, "pendente", null, job.missingNote ?? "O lead não informa este perfil e o site não aponta para ele.");
    return;
  }
  const page = await job.fetchPage(url);
  const profile = parseProfile(page.body, page.status, page.finalUrl);
  if (page.status === null && !page.body) {
    setSource(key, "parcial", url, page.error ? `Não foi possível consultar: ${page.error}.` : "Não foi possível consultar agora.", true);
  } else if (page.status === 404 || page.status === 410) {
    setSource(key, "parcial", url, `O endereço informado não existe mais (HTTP ${page.status}).`, true);
  } else if (profile.blocked) {
    setSource(key, "bloqueada", url, `Fonte bloqueada: ${profile.blockReason}. O dado não foi inventado.`, true);
    // O cadastro do lead já diz que o perfil existe: isso é um fato, com a origem declarada.
    if (job.declared) {
      job.sink.add("presenca", `O lead informa o perfil ${job.label} (${SOURCE_LABEL[key]}), mas a fonte não o mostra sem login.`, [
        { source: key, url, excerpt: `Perfil ${job.label} informado no cadastro do lead (origem: ${job.lead.source})` },
      ]);
    }
  } else {
    setSource(key, "concluida", url, null, true);
    const d = job.describe(profile, job.label);
    job.sink.add(job.kind, d.claim, [{ source: key, url, excerpt: d.excerpt }]);
  }
}

/** Transforma o que foi medido no site em afirmações, cada uma com o trecho que a sustenta. */
function describeSite(sink: FindingSink, facts: SiteFacts, assessment: SiteAssessment, url: string, lead: Lead) {
  const ev = (excerpt: string): DossierEvidence[] => [{ source: "site", url, excerpt }];

  if (facts.title) sink.add("identidade", `Título do site: “${facts.title}”.`, ev(`<title> da página: ${facts.title}`));
  if (facts.platform) sink.add("identidade", `Site feito em ${facts.platform}.`, ev(`Assinatura de ${facts.platform} encontrada no código da página`));
  if (facts.themeColor) sink.add("identidade", `Cor de destaque do site: ${facts.themeColor}.`, ev(`theme-color: ${facts.themeColor}`));

  if (facts.h2.length > 0) sink.add("oferta", `O site organiza o conteúdo em seções: ${facts.h2.slice(0, 5).join("; ")}.`, facts.h2.slice(0, 5).map((h) => ({ source: "site" as const, url, excerpt: `Subtítulo da página: ${h}` })));
  if (facts.prices.length > 0) sink.add("oferta", "O site publica preços.", facts.prices.slice(0, 3).map((p) => ({ source: "site" as const, url, excerpt: p })));

  if (facts.whatsapp) sink.add("contato", `WhatsApp publicado no site (${facts.whatsapp}).`, ev(`Link de WhatsApp na página: ${facts.whatsapp}`));
  if (facts.phones[0]) sink.add("contato", `Telefone publicado no site (${facts.phones[0]}).`, ev(`Telefone no texto da página: ${facts.phones[0]}`));
  if (facts.email) sink.add("contato", `E-mail da empresa publicado no site (${facts.email}).`, ev(`E-mail da empresa (mesmo domínio ou provedor público): ${facts.email}`));
  if (facts.links.instagram) sink.add("presenca", `O site liga ao Instagram ${facts.links.instagram}.`, ev(`Link para instagram.com/${facts.links.instagram.replace("@", "")} na página`));
  if (facts.socialProof[0]) sink.add("destaque", "O site mostra prova social (depoimentos, avaliações ou portfólio).", ev(`Trecho da página: ${facts.socialProof[0]}`));

  // O que a rubrica mediu de errado vira problema (ou lacuna, quando é ausência).
  if (facts.parked) sink.add("problema", "O endereço é uma página de domínio à venda ou estacionado.", ev("Texto de domínio à venda/estacionado na página"));
  if (facts.underConstruction) sink.add("problema", "O site está “em construção”.", ev(`Trecho da página: ${facts.textSample}`));
  if (!facts.hasViewport) sink.add("problema", "O site não se adapta ao celular.", ev("A página não tem a tag <meta name=\"viewport\">"));
  if (facts.cheapBuilder) sink.add("problema", "O site está em um construtor gratuito.", ev(`Endereço/código indica construtor gratuito: ${hostOf(url)}`));
  if (facts.copyrightYear && facts.copyrightYear <= new Date().getFullYear() - 3) sink.add("problema", `O site parece parado: o rodapé diz © ${facts.copyrightYear}.`, ev(`Rodapé da página: © ${facts.copyrightYear}`));
  if (facts.outdatedSignals.length > 0) sink.add("problema", `O site tem sinais de ser antigo (${facts.outdatedSignals.join("; ")}).`, ev(`Medido no código: ${facts.outdatedSignals.join("; ")}`));
  if (!facts.https) sink.add("problema", "O site não usa HTTPS.", ev(`Endereço final: ${url}`));
  const item = (k: string) => assessment.rubric.find((r) => r.key === k);
  if (facts.ctas.length === 0 && !facts.whatsapp && facts.phones.length === 0) sink.add("lacuna", "O site não deixa claro como entrar em contato.", ev(`Medido: ${item("cta")?.evidence ?? "sem chamada para ação nem contato visível"}`));
  else if (facts.ctas.length === 0) sink.add("lacuna", "O site não tem uma chamada para ação clara.", ev(`Medido: ${item("cta")?.evidence ?? "nenhum botão ou link de ação"}`));
  if (facts.socialProof.length === 0) sink.add("lacuna", "O site não mostra prova social (depoimentos, avaliações, portfólio).", ev(`Medido: ${item("prova_social")?.evidence ?? "nenhuma menção encontrada"}`));
  if ((item("oferta")?.score ?? 5) <= 2) sink.add("lacuna", "O site não deixa claro o que a empresa oferece.", ev(`Medido: ${item("oferta")?.evidence}`));
  void lead;
}

/* ------------------------------------------------------------------ */
/* Validação, frase principal e resumo                                 */
/* ------------------------------------------------------------------ */

/** Lista o que quebra a regra "toda afirmação tem evidência" (vazia = dossiê íntegro). */
export function validateDossier(d: { sources: DossierSource[]; findings: DossierFinding[] }): string[] {
  const problems: string[] = [];
  const bySource = new Map(d.sources.map((s) => [s.key, s]));
  for (const f of d.findings) {
    if (f.evidence.length === 0) problems.push(`${f.id}: sem evidência`);
    for (const e of f.evidence) {
      if (!e.excerpt.trim()) problems.push(`${f.id}: trecho de evidência vazio`);
      const s = bySource.get(e.source);
      if (!s) problems.push(`${f.id}: fonte desconhecida (${e.source})`);
      else if (s.status === "pendente") problems.push(`${f.id}: evidência de fonte que não foi consultada (${e.source})`);
    }
  }
  return problems;
}

const HEADLINE_RULES: Array<{ match: (f: DossierFinding) => boolean; text: (f: DossierFinding) => string }> = [
  { match: (f) => /domínio à venda|estacionado/.test(f.claim), text: () => "O endereço do site de vocês hoje é uma página de domínio à venda." },
  { match: (f) => /não abre/.test(f.claim), text: () => "O site de vocês não está abrindo." },
  { match: (f) => /em construção/.test(f.claim), text: () => "O site de vocês está marcado como “em construção”." },
  { match: (f) => /não tem site informado/.test(f.claim), text: () => "A ficha de vocês no Google não tem um site para quem quer saber mais." },
  { match: (f) => /não se adapta ao celular/.test(f.claim), text: () => "O site de vocês não se adapta ao celular." },
  { match: (f) => /construtor gratuito/.test(f.claim), text: () => "O site de vocês está num construtor gratuito, o que passa menos confiança." },
  { match: (f) => /parece parado/.test(f.claim), text: (f) => `O site de vocês parece parado${/© (\d{4})/.exec(f.claim) ? ` desde ${/© (\d{4})/.exec(f.claim)![1]}` : ""}.` },
  { match: (f) => /não deixa claro como entrar em contato/.test(f.claim), text: () => "O site de vocês não deixa claro como entrar em contato." },
  { match: (f) => /não deixa claro o que a empresa oferece/.test(f.claim), text: () => "O site de vocês não deixa claro o que vocês oferecem." },
  { match: (f) => /chamada para ação/.test(f.claim), text: () => "O site de vocês não tem um botão claro para o cliente chamar." },
];

/** A primeira frase do maior problema comprovado — é o que a abordagem pode citar. */
export function headlineProblem(findings: DossierFinding[]): string | null {
  const real = findings.filter((f) => f.kind === "problema" || f.kind === "lacuna");
  for (const rule of HEADLINE_RULES) {
    const hit = real.find(rule.match);
    if (hit) return rule.text(hit);
  }
  return null;
}

export function confidenceOf(sources: DossierSource[], findings: DossierFinding[], synthetic: boolean): number {
  if (synthetic) return 10;
  let score = 100;
  for (const s of sources) {
    if (s.status === "bloqueada") score -= 12;
    else if (s.status === "parcial") score -= 6;
  }
  const attempted = sources.filter((s) => s.status === "concluida" || s.status === "parcial").length;
  if (attempted === 0) score = Math.min(score, 25);
  if (findings.length === 0) score = Math.min(score, 30);
  return Math.max(0, Math.min(100, score));
}

export function summaryOf(sources: DossierSource[], findings: DossierFinding[], headline: string | null): string {
  const done = sources.filter((s) => s.status === "concluida").length;
  const blocked = sources.filter((s) => s.status === "bloqueada").length;
  const parts = [`${findings.length} afirmação(ões) com evidência, em ${done} fonte(s) consultada(s)`];
  if (blocked > 0) parts.push(`${blocked} fonte(s) bloqueada(s)`);
  return `${parts.join("; ")}.${headline ? ` Principal problema: ${headline}` : ""}`;
}
