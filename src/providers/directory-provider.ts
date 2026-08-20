import type { RawLead, SearchParams } from "@/types";
import type { LeadProvider } from "@/providers/types";
import { customNiche, FIRST_NAMES, nicheByKey, NICHES, OPENING_HOURS, STREET_NAMES } from "@/providers/directory-data";

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

    // gera um excedente para compensar os descartados pelos filtros
    const attempts = params.quantity * 6;

    for (let i = 0; i < attempts && results.length < params.quantity; i++) {
      const prefix = pick(niche.nameParts.prefixes);
      const core = pick(niche.nameParts.cores);
      const suffix = pick(niche.nameParts.suffixes);
      const name = [prefix, core, suffix].filter(Boolean).join(" ").trim();
      if (usedNames.has(name)) continue;
      usedNames.add(name);

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
        source_id: `dir_${slug}_${Math.floor(rand() * 100000)}`,
        website_quality: websiteQuality,
        instagram_active: instagramActive,
        marketing_signals: strongSocial || chance(0.25),
        business_active: businessActive,
        catalog_size: pick(niche.catalogBias),
      });

      // nome de contato em ~60% dos casos
      if (chance(0.6)) {
        results[results.length - 1] = {
          ...results[results.length - 1]!,
        };
      }
    }

    // simula latência de rede da fonte externa
    await new Promise((r) => setTimeout(r, 300 + rand() * 500));

    return results;
  }
}

export function contactNameMaybe(): string | null {
  return Math.random() < 0.6 ? FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]! : null;
}
