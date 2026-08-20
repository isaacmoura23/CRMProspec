import type { RawLead, SearchParams } from "@/types";

/**
 * Arquitetura desacoplada de fontes de prospecção.
 * Novas fontes (Google Places, diretórios, webhooks…) implementam
 * esta interface e são registradas no registry.
 */
export interface LeadProvider {
  id: string;
  name: string;
  /** Provider está pronto para uso (ex.: chave de API configurada)? */
  isConfigured(): boolean;
  search(params: SearchParams): Promise<RawLead[]>;
}
