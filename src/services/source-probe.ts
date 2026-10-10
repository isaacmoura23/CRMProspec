import "server-only";
import { getActiveProvider } from "@/providers/registry";
import { enrichBatch } from "@/services/enrichment";
import { isWeakWebsite } from "@/services/lead-filter";
import type { NicheMetrics } from "@/types/agents";
import type { RawLead } from "@/types";

/**
 * Sondagem da fonte de empresas, sem gravar lead nenhum.
 *
 * Nasceu como a ferramenta `fonte_sondar` do servidor MCP e agora é usada
 * também pelo Agente 1: medir o que a fonte tem a oferecer (quantas empresas
 * sem site, com telefone…) antes de decidir onde prospectar. Gasta cota
 * cobrada do provedor — quem chama controla o teto.
 */

export interface ProbeInput {
  niche: string;
  city: string;
  state?: string;
  country: string;
  /** Empresas pedidas à fonte. */
  sample: number;
  /** Quantos sites visitar para medir se são fracos (0 = não medir). */
  probeSites?: number;
  /** Chamado a cada requisição cobrada. */
  onRequest?: () => void;
}

export interface ProbeResult {
  provider: string;
  /** Dados reais (Google Places) ou de demonstração. */
  live: boolean;
  metrics: NicheMetrics;
  companies: RawLead[];
}

export function measureCompanies(companies: RawLead[], sitesSampled: RawLead[]): NicheMetrics {
  const withSite = companies.filter((c) => c.website);
  return {
    total: companies.length,
    no_site: companies.length - withSite.length,
    with_site: withSite.length,
    sites_sampled: sitesSampled.length,
    weak_sites: sitesSampled.filter((c) => isWeakWebsite(c)).length,
    with_phone: companies.filter((c) => c.phone).length,
    with_reviews: companies.filter((c) => (c.reviews_count ?? 0) > 0).length,
  };
}

export async function probeSource(input: ProbeInput): Promise<ProbeResult> {
  const provider = getActiveProvider();
  const companies = await provider.search(
    {
      niche: input.niche,
      country: input.country,
      state: input.state,
      city: input.city,
      quantity: input.sample,
      filters: {},
    },
    { onRequest: input.onRequest }
  );

  // Visitar o site é o que revela se ele é fraco (sem viewport, copyright
  // antigo, construtor barato). Só uma amostra: cada visita leva segundos.
  const toVisit = companies.filter((c) => c.website).slice(0, Math.max(0, input.probeSites ?? 0));
  const visited = toVisit.length > 0 ? await enrichBatch(toVisit) : [];

  return {
    provider: provider.id,
    live: provider.id === "google_places",
    metrics: measureCompanies(companies, visited),
    companies,
  };
}
