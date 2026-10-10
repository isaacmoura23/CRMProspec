import type { RawLead, SearchParams } from "@/types";

/**
 * Arquitetura desacoplada de fontes de prospecção.
 * Novas fontes (Google Places, diretórios, webhooks…) implementam
 * esta interface e são registradas no registry.
 */
/** Ganchos opcionais para quem precisa medir o custo de uma busca. */
export interface SearchHooks {
  /** Chamado antes de cada requisição cobrada à fonte. */
  onRequest?: () => void;
}

export interface LeadProvider {
  id: string;
  name: string;
  /** Provider está pronto para uso (ex.: chave de API configurada)? */
  isConfigured(): boolean;
  search(params: SearchParams, hooks?: SearchHooks): Promise<RawLead[]>;
}
