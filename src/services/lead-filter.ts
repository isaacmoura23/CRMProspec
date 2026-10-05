import { instagramHandle } from "@/lib/utils";
import type { RawLead, SearchParams } from "@/types";

/**
 * Aplica as "Características desejadas" da busca sobre leads já
 * enriquecidos. Usado pelo job de prospecção para descartar empresas
 * fora do perfil — os providers apenas buscam; quem garante o filtro é o job.
 */
/** Rótulos como aparecem na tela, para o relatório dizer o que cada um derrubou. */
export const FILTER_LABEL: Record<string, string> = {
  hasPhone: "Possui telefone",
  hasWhatsapp: "Possui WhatsApp",
  hasInstagram: "Possui Instagram",
  hasEmail: "Possui e-mail",
  noWebsite: "Sem site",
  hasWebsite: "Possui site",
  badWebsite: "Site potencialmente ruim",
  activeBusiness: "Empresa ativa",
  hasReviews: "Empresa com avaliações",
  strongSocial: "Presença forte em redes sociais",
};

/**
 * Por que esta empresa foi descartada — na ordem dos filtros da tela.
 *
 * Saber o total descartado não ajuda quem marcou seis critérios: o que
 * resolve é ver qual deles derrubou quantas empresas.
 */
export function rejectionReasons(raw: RawLead, f: SearchParams["filters"]): string[] {
  const motivos: string[] = [];
  if (f.hasPhone && !raw.phone) motivos.push("hasPhone");
  if (f.hasWhatsapp && !raw.whatsapp) motivos.push("hasWhatsapp");
  if (f.hasInstagram && !instagramHandle(raw.instagram)) motivos.push("hasInstagram");
  if (f.hasEmail && !raw.email) motivos.push("hasEmail");
  if (f.noWebsite && raw.website) motivos.push("noWebsite");
  if (f.hasWebsite && !raw.website) motivos.push("hasWebsite");
  if (f.badWebsite && !(raw.website && (raw.website_quality === "ruim" || raw.website_quality === "desatualizado"))) {
    motivos.push("badWebsite");
  }
  if (f.activeBusiness && raw.business_active === false) motivos.push("activeBusiness");
  if (f.hasReviews && (raw.reviews_count ?? 0) < 1) motivos.push("hasReviews");
  if (f.strongSocial && !(instagramHandle(raw.instagram) && (raw.instagram_active || raw.marketing_signals))) {
    motivos.push("strongSocial");
  }
  return motivos;
}

/**
 * Combinações que quase nunca devolvem resultado, para a tela avisar antes
 * de a pessoa esperar a busca inteira.
 *
 * O enriquecimento descobre Instagram, WhatsApp e e-mail **visitando o site**
 * da empresa. Numa base real de 84 imobiliárias: com site, 75% tinham
 * Instagram e 51% e-mail; sem site, 17% e 0%. Então "sem site" junto com
 * qualquer um desses é, na prática, um pedido vazio.
 */
export function filterWarnings(f: SearchParams["filters"]): string[] {
  const avisos: string[] = [];
  if (f.noWebsite && f.hasWebsite) {
    avisos.push("“Sem site” e “Possui site” se excluem: nenhuma empresa atende aos dois.");
  }
  if (f.noWebsite && f.badWebsite) {
    avisos.push("“Sem site” e “Site potencialmente ruim” se excluem — o segundo exige que haja site.");
  }
  const dependemDoSite = [
    f.hasInstagram && "Possui Instagram",
    f.hasEmail && "Possui e-mail",
    f.hasWhatsapp && "Possui WhatsApp",
    f.strongSocial && "Presença forte em redes sociais",
  ].filter(Boolean) as string[];
  if (f.noWebsite && dependemDoSite.length > 0) {
    avisos.push(
      `${dependemDoSite.join(", ")} ${dependemDoSite.length > 1 ? "dependem" : "depende"} de visitar o site da empresa, e você pediu “Sem site”. A busca tende a voltar vazia — considere tirar “Sem site” ou esses critérios.`
    );
  }
  const exigencias = Object.entries(f).filter(([, v]) => v).length;
  if (exigencias >= 5 && avisos.length === 0) {
    avisos.push(`${exigencias} critérios ao mesmo tempo deixam poucas empresas de fora do descarte. Se vier vazio, tire os menos importantes.`);
  }
  return avisos;
}

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

/**
 * Critérios que poucas empresas atendem — e que por isso exigem varrer bem
 * mais resultados antes de desistir.
 *
 * "Sem site" é o caso extremo: numa busca de imobiliárias em São Paulo, as
 * 30 empresas trazidas pelo Google tinham site, e o pedido terminou em zero
 * sem nunca ter chegado perto do teto de 60 que a fonte permite.
 */
export function hasRareFilters(f: SearchParams["filters"]): boolean {
  return Boolean(f.noWebsite || f.badWebsite || f.hasEmail || f.strongSocial);
}

export function hasActiveFilters(f: SearchParams["filters"]): boolean {
  return Object.values(f).some(Boolean);
}
