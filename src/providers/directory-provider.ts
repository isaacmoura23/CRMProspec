import type { RawLead, SearchParams } from "@/types";
import type { LeadProvider } from "@/providers/types";
import {
  customNiche,
  FIRST_NAMES,
  GENERIC_CORES,
  nicheByKey,
  OPENING_HOURS,
  STREET_NAMES,
  SURNAMES,
  type NicheProfile,
} from "@/providers/directory-data";

/**
 * Provider de diretório empresarial (modo demonstração).
 *
 * Simula uma fonte de dados comercial gerando empresas realistas e
 * coerentes com o nicho/localização pesquisados. Em produção, é
 * substituído/complementado pelo GooglePlacesProvider e por outras
 * fontes registradas no registry.
 */

function rand(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)]!;
}

function chance(p: number): boolean {
  return rand() < p;
}

function phoneFor(country: string): string {
  if (country.toLowerCase().includes("portugal")) {
    const prefix = pick(["21", "22", "25", "23", "28"]);
    return `+351 ${prefix} ${100 + Math.floor(rand() * 899)} ${1000 + Math.floor(rand() * 8999)}`;
  }
  const ddd = pick(["11", "21", "31", "41", "47", "48", "51", "61", "62", "71", "81", "85"]);
  return `+55 ${ddd} 3${100 + Math.floor(rand() * 899)}-${1000 + Math.floor(rand() * 8999)}`;
}

function mobileFor(country: string): string {
  if (country.toLowerCase().includes("portugal")) {
    return `+351 9${pick(["1", "2", "3", "6"])}${Math.floor(rand() * 10)} ${100 + Math.floor(rand() * 899)} ${100 + Math.floor(rand() * 899)}`;
  }
  const ddd = pick(["11", "21", "31", "41", "47", "48", "51", "61", "62", "71", "81", "85"]);
  return `+55 ${ddd} 9${8000 + Math.floor(rand() * 1999)}-${1000 + Math.floor(rand() * 8999)}`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
}

/**
 * Miolo do nome da empresa.
 *
 * A lista fixa de `cores` dava só algumas dezenas de nomes por nicho, e como
 * e-mail, site e Instagram são derivados do nome, todo nome repetido colidia
 * de quatro formas no dedupe — a segunda busca no mesmo nicho e cidade já
 * entregava bem menos que o pedido, e a terceira podia não entregar nada.
 * Compor com nomes e sobrenomes leva o espaço de dezenas para milhares.
 */
function nameCore(niche: NicheProfile): string {
  if (niche.personName) {
    return `${pick(FIRST_NAMES)} ${pick(SURNAMES)}`;
  }
  const roll = rand();
  // Sociedade familiar ("Andrade & Nogueira") — duas listas cruzadas, é o
  // que mais amplia o espaço.
  if (roll < 0.2) {
    const a = pick(SURNAMES);
    let b = pick(SURNAMES);
    while (b === a) b = pick(SURNAMES);
    return `${a} & ${b}`;
  }
  // Negócio de família ("Imobiliária Andrade") é tão comum quanto nome de
  // fantasia, então o sobrenome entra como alternativa em qualquer nicho.
  if (roll < 0.5) return pick(SURNAMES);
  if (roll < 0.75) return pick(GENERIC_CORES);
  return pick(niche.nameParts.cores);
}

/** "Imobiliária" e "Negócios Imobiliários" compartilham a raiz "imobilia". */
function sharesRoot(a: string, b: string): boolean {
  if (!a || !b) return false;
  const root = normalizeName(a).replace(/\s+/g, "").slice(0, 8);
  return root.length >= 5 && normalizeName(b).replace(/\s+/g, "").includes(root);
}

/** Mesma normalização usada pelo dedupe, para os dois concordarem. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Identidade estável da empresa dentro da cidade.
 *
 * Antes o id terminava em um número aleatório, o que tornava
 * `excludeSourceIds` inútil: o mesmo negócio voltava a ser sorteado com um id
 * diferente a cada busca, e só era barrado lá na frente pelo dedupe.
 */
function sourceIdFor(name: string, city: string): string {
  return `dir_${slugify(city)}_${slugify(name)}`;
}

export class DirectoryProvider implements LeadProvider {
  id = "diretorio";
  name = "Diretório empresarial";

  isConfigured(): boolean {
    return true;
  }

  async search(params: SearchParams): Promise<RawLead[]> {
    const niche = nicheByKey(params.niche) ?? customNiche(params.niche);
    const isPT = params.country.toLowerCase().includes("portugal");
    const results: RawLead[] = [];
    const usedNames = new Set<string>();
    // Empresas já entregues em buscas anteriores: pular aqui evita gastar a
    // busca inteira com candidatos que o dedupe descartaria depois.
    const excludedIds = new Set(params.excludeSourceIds ?? []);
    const excludedNames = new Set((params.excludeNames ?? []).map(normalizeName));

    // Gera um excedente para compensar os descartados pelos filtros. O teto é
    // alto porque, com a base já povoada, boa parte dos sorteios cai em
    // empresas conhecidas — sem isso a busca devolvia menos do que o pedido.
    const attempts = Math.max(params.quantity * 25, 400);

    for (let i = 0; i < attempts && results.length < params.quantity; i++) {
      const core = nameCore(niche);
      const suffix = pick(niche.nameParts.suffixes);
      // Prefixo e sufixo da mesma família geram "Imobiliária Pantanal
      // Imobiliária"; nesses casos o prefixo cai.
      const rawPrefix = pick(niche.nameParts.prefixes);
      let prefix = sharesRoot(rawPrefix, suffix) ? "" : rawPrefix;
      // Prefixo e sufixo vazios deixariam só o miolo ("Peixoto"), que não
      // identifica o ramo; nesse caso o prefixo é obrigatório.
      if (!prefix && !suffix) {
        prefix = niche.nameParts.prefixes.find(Boolean) ?? "";
      }
      const name = [prefix, core, suffix].filter(Boolean).join(" ").trim();
      if (usedNames.has(name)) continue;
      usedNames.add(name);

      if (excludedNames.has(normalizeName(name))) continue;
      const sourceId = sourceIdFor(name, params.city);
      if (excludedIds.has(sourceId)) continue;

      const f = params.filters;

      // atributos gerados com probabilidades realistas, viesados pelos filtros
      const hasWebsite = f.noWebsite ? false : f.hasWebsite || f.badWebsite ? true : chance(niche.websiteRate);
      const websiteQuality: RawLead["website_quality"] = !hasWebsite
        ? "nenhum"
        : f.badWebsite
          ? pick(["ruim", "desatualizado"])
          : pick(["bom", "desatualizado", "ruim", "bom", "desatualizado"]);
      const hasInstagram = f.hasInstagram ? true : chance(0.75);
      const instagramActive = hasInstagram && chance(0.7);
      const hasPhone = f.hasPhone ? true : chance(0.9);
      const hasWhatsapp = f.hasWhatsapp ? true : chance(0.7);
      const hasEmail = f.hasEmail ? true : chance(0.45);
      const hasReviews = f.hasReviews ? true : chance(0.7);
      const businessActive = f.activeBusiness ? true : chance(0.92);
      const strongSocial = instagramActive && chance(0.5);

      // valida filtros que não podem ser forçados na geração
      if (f.strongSocial && !strongSocial) continue;
      if (f.hasInstagram && !hasInstagram) continue;

      const slug = slugify(name);
      const reviews = hasReviews ? 5 + Math.floor(rand() * 480) : 0;
      const rating = hasReviews ? Math.round((3.4 + rand() * 1.6) * 10) / 10 : undefined;

      results.push({
        company_name: name,
        segment: niche.label,
        description: pick(niche.descriptions),
        phone: hasPhone ? phoneFor(params.country) : undefined,
        whatsapp: hasWhatsapp ? mobileFor(params.country) : undefined,
        email: hasEmail ? `${pick(["contato", "geral", "info", "comercial"])}@${slug}.${isPT ? "pt" : "com.br"}` : undefined,
        website: hasWebsite
          ? websiteQuality === "ruim"
            ? `http://${slug}.${pick(["blogspot.com", "wixsite.com/site", "webnode.page"])}`
            : `https://${slug}.${isPT ? "pt" : "com.br"}`
          : undefined,
        instagram: hasInstagram ? `@${slug}` : undefined,
        facebook: chance(0.5) ? slug : undefined,
        country: params.country,
        state: params.state,
        city: params.city,
        address: `${pick(STREET_NAMES)}, ${10 + Math.floor(rand() * 1900)}`,
        reviews_count: reviews,
        rating,
        opening_hours: pick(OPENING_HOURS),
        source: "diretorio",
        source_id: sourceId,
        website_quality: websiteQuality,
        instagram_active: instagramActive,
        marketing_signals: strongSocial || chance(0.25),
        business_active: businessActive,
        catalog_size: pick(niche.catalogBias),
      });

    }

    // simula latência de rede da fonte externa
    await new Promise((r) => setTimeout(r, 300 + rand() * 500));

    return results;
  }
}

export function contactNameMaybe(): string | null {
  return Math.random() < 0.6 ? FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]! : null;
}
