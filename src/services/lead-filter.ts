import { instagramHandle } from "@/lib/utils";
import type { RawLead, SearchParams } from "@/types";

/**
 * Aplica as "Características desejadas" da busca sobre leads já
 * enriquecidos. Usado pelo job de prospecção para descartar empresas
 * fora do perfil — os providers apenas buscam; quem garante o filtro é o job.
 */
export function matchesFilters(raw: RawLead, f: SearchParams["filters"]): boolean {
  if (f.hasPhone && !raw.phone) return false;
  if (f.hasWhatsapp && !raw.whatsapp) return false;
  // conta como "possui Instagram" apenas um handle que gera link válido
  if (f.hasInstagram && !instagramHandle(raw.instagram)) return false;
  if (f.hasEmail && !raw.email) return false;
  if (f.noWebsite && raw.website) return false;
  if (f.hasWebsite && !raw.website) return false;
  if (
    f.badWebsite &&
    !(raw.website && (raw.website_quality === "ruim" || raw.website_quality === "desatualizado"))
  ) {
    return false;
  }
  if (f.activeBusiness && raw.business_active === false) return false;
  if (f.hasReviews && (raw.reviews_count ?? 0) < 1) return false;
  if (
    f.strongSocial &&
    !(instagramHandle(raw.instagram) && (raw.instagram_active || raw.marketing_signals))
  ) {
    return false;
  }
  return true;
}

export function hasActiveFilters(f: SearchParams["filters"]): boolean {
  return Object.values(f).some(Boolean);
}
