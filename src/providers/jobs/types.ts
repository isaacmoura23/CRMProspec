import type { WorkMode } from "@/types/career";

/**
 * Contrato dos provedores de vagas.
 *
 * Fontes de listagem pública não implicam permissão nem API para se
 * candidatar: `applyCapability` diz o que a fonte realmente oferece. Um
 * anúncio sem e-mail publicado ou conector oficial vira "ação manual".
 */

export interface JobSearchQuery {
  /** Termos de busca (cargo, competências). */
  terms: string[];
  location?: string | null;
  remoteOnly?: boolean;
  page?: number;
  perPage?: number;
}

export interface RawJob {
  source: string;
  external_id: string;
  title: string;
  company: string;
  /** Texto simples (o provedor já converte HTML). */
  description: string;
  location: string | null;
  work_mode: WorkMode | null;
  url: string;
  apply_url: string | null;
  application_email: string | null;
  application_email_evidence: string | null;
  salary: string | null;
  contract_type: string | null;
  posted_at: string | null;
  expires_at: string | null;
  /** De onde exatamente este registro veio (endpoint/URL). */
  origin_evidence: string;
}

export class RateLimitedError extends Error {
  constructor(public retryAfterMs: number, message = "Limite de requisições do provedor") {
    super(message);
    this.name = "RateLimitedError";
  }
}

export interface JobProvider {
  id: string;
  name: string;
  /** Cobertura declarada, exibida na interface. */
  coverage: string;
  /** "demo" nunca deve ser confundida com fonte real. */
  isDemo: boolean;
  applyCapability: "email_publicado" | "link_externo";
  isConfigured(): boolean;
  search(query: JobSearchQuery): Promise<{ jobs: RawJob[]; hasMore: boolean }>;
  /** Revalida se o anúncio continua no ar. `null` = não foi possível saber. */
  checkAvailability(externalId: string, url: string): Promise<boolean | null>;
}
