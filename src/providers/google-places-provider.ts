import type { RawLead, SearchParams } from "@/types";
import type { LeadProvider } from "@/providers/types";
import { nicheByKey } from "@/providers/directory-data";
import { extractInstagramHandle, extractWhatsapp } from "@/services/enrichment";

/**
 * Provider Google Places (Places API — Text Search v1).
 * Ativado quando GOOGLE_PLACES_API_KEY está configurada no servidor.
 *
 * Responsabilidades: buscar empresas coerentes com o nicho (query pelo
 * rótulo + validação por tipo do Google) e paginar até a quantidade
 * pedida. Enriquecimento e filtros finais acontecem no job.
 */

const PAGE_SIZE = 20;
const MAX_RESULTS = 60; // limite do Text Search com paginação
/** Teto de variações de consulta por busca — cada uma é uma chamada cobrada. */
const MAX_QUERY_VARIANTS = 4;

/** Nicho da UI → tipos do Google Places aceitos (validação do resultado) */
const NICHE_TYPES: Record<string, { includedType?: string; accept: string[] }> = {
  imobiliaria: { includedType: "real_estate_agency", accept: ["real_estate_agency", "real_estate_agent"] },
  corretor: { includedType: "real_estate_agency", accept: ["real_estate_agency", "real_estate_agent"] },
  loja_veiculos: { includedType: "car_dealer", accept: ["car_dealer", "car_rental", "car_repair"] },
  clinica: { accept: ["doctor", "dentist", "dental_clinic", "hospital", "physiotherapist", "medical_lab", "clinic", "health"] },
  estetica: { includedType: "beauty_salon", accept: ["beauty_salon", "spa", "hair_salon", "nail_salon", "skin_care_clinic", "hair_care"] },
  personal: { includedType: "gym", accept: ["gym", "fitness_center", "sports_complex", "health"] },
  nutricionista: { accept: ["nutritionist", "doctor", "health"] },
  arquiteto: { accept: [] },
  advogado: { includedType: "lawyer", accept: ["lawyer", "legal_services"] },
  hotel: { includedType: "hotel", accept: ["hotel", "lodging", "resort_hotel", "extended_stay_hotel", "motel"] },
  pousada: { includedType: "bed_and_breakfast", accept: ["bed_and_breakfast", "guest_house", "inn", "lodging", "hotel", "campground", "farmstay"] },
  loja_roupas: { includedType: "clothing_store", accept: ["clothing_store", "shoe_store", "store"] },
  restaurante: { includedType: "restaurant", accept: ["restaurant", "food", "cafe", "bar", "bakery", "meal_takeaway", "meal_delivery"] },
};

/**
 * Formas alternativas de pedir o mesmo nicho ao Google.
 *
 * Com uma única consulta, o Text Search devolve sempre o mesmo recorte
 * ordenado por relevância — a segunda prospecção no mesmo nicho e cidade
 * traria as mesmas empresas. Alternar entre termos equivalentes faz o
 * Google explorar cantos diferentes do índice, então cada busca traz
 * empresas diferentes sem mudar o que está sendo procurado.
 */
const NICHE_QUERIES: Record<string, string[]> = {
  imobiliaria: ["imobiliária", "corretora de imóveis", "imobiliária locação", "imobiliária venda de imóveis", "administradora de imóveis"],
  corretor: ["corretor de imóveis", "consultor imobiliário", "corretora de imóveis autônoma"],
  loja_veiculos: ["loja de veículos", "concessionária de seminovos", "revenda de carros", "multimarcas veículos"],
  clinica: ["clínica médica", "consultório médico", "centro clínico", "clínica de especialidades"],
  estetica: ["clínica de estética", "centro de estética", "estética avançada", "salão de beleza e estética"],
  personal: ["personal trainer", "estúdio de treinamento funcional", "assessoria esportiva", "studio de personal"],
  nutricionista: ["nutricionista", "consultório de nutrição", "clínica de nutrição"],
  arquiteto: ["escritório de arquitetura", "arquiteto", "arquitetura e interiores", "design de interiores"],
  advogado: ["escritório de advocacia", "advogado", "sociedade de advogados", "assessoria jurídica"],
  hotel: ["hotel", "hotelaria", "hotel executivo", "apart hotel"],
  pousada: ["pousada", "hospedagem", "pousada charmosa", "guest house"],
  loja_roupas: ["loja de roupas", "boutique de moda", "loja de vestuário", "moda feminina loja"],
  restaurante: ["restaurante", "bistrô", "casa de comida", "restaurante almoço"],
};

const REGION_CODES: Record<string, string> = {
  brasil: "BR",
  portugal: "PT",
  angola: "AO",
  ["moçambique"]: "MZ",
  mocambique: "MZ",
};

interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  businessStatus?: string;
  types?: string[];
  primaryType?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
}

const SOCIAL_HOSTS = /(instagram\.com|facebook\.com|linktr\.ee|wa\.me|api\.whatsapp\.com|bio\.link|beacons\.ai|taplink)/i;
const AGGREGATOR_HOSTS = /(linktr\.ee|bio\.link|beacons\.ai|taplink)/i;

/**
 * Traduz a recusa do Google para algo acionável.
 *
 * O status sozinho ("respondeu 403") não diz se a chave é inválida, se a
 * Places API não foi habilitada no projeto ou se falta faturamento — que
 * são as três causas comuns e exigem ações diferentes.
 */
async function describeApiError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // resposta sem JSON — fica só o status
  }
  const lower = detail.toLowerCase();
  if (res.status === 400 && lower.includes("api key not valid")) {
    return "A chave do Google Places é inválida. Confira o valor de GOOGLE_PLACES_API_KEY.";
  }
  if (res.status === 403 && lower.includes("has not been used")) {
    return "A Places API (New) não está habilitada neste projeto do Google Cloud. Habilite-a e tente de novo.";
  }
  if (res.status === 403 && (lower.includes("billing") || lower.includes("faturamento"))) {
    return "O projeto do Google Cloud precisa de uma conta de faturamento ativa para usar a Places API.";
  }
  if (res.status === 403) {
    return `O Google recusou a chamada (403). Verifique as restrições da chave — de aplicativo e de API. ${detail}`.trim();
  }
  if (res.status === 429) {
    return "Cota da Places API esgotada por agora. Tente novamente mais tarde ou aumente o limite no Google Cloud.";
  }
  return `Google Places respondeu ${res.status}. ${detail}`.trim();
}

/** Fisher–Yates — cada busca amostra empresas diferentes do resultado */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function matchesNiche(place: GooglePlace, nicheKey: string): boolean {
  const mapping = NICHE_TYPES[nicheKey];
  if (!mapping || mapping.accept.length === 0) return true; // nicho custom: confia na query
  const types = [...(place.types ?? []), place.primaryType].filter(Boolean) as string[];
  return types.some(
    (t) => mapping.accept.includes(t) || mapping.accept.some((a) => t.endsWith(`_${a}`) || t.startsWith(`${a}_`))
  );
}

export class GooglePlacesProvider implements LeadProvider {
  id = "google_places";
  name = "Google Places";

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_PLACES_API_KEY);
  }

  async search(params: SearchParams): Promise<RawLead[]> {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return [];

    const nicheLabel = nicheByKey(params.niche)?.label ?? params.niche;
    const mapping = NICHE_TYPES[params.niche];
    const local = `${params.city}${params.state ? `, ${params.state}` : ""}, ${params.country}`;
    // Ordem embaralhada: a consulta de partida muda a cada prospecção, então
    // duas buscas iguais não devolvem a mesma lista.
    const queries = shuffle(NICHE_QUERIES[params.niche] ?? [nicheLabel]).map(
      (term) => `${term} em ${local}`
    );
    const regionCode = REGION_CODES[params.country.trim().toLowerCase()];
    const wanted = Math.min(params.quantity, MAX_RESULTS);
    const excluded = new Set(params.excludeSourceIds ?? []);
    // O place_id é estável, mas um mesmo negócio pode ter fichas duplicadas
    // no Google; excluir por nome evita reentregar o que já está na base.
    const excludedNames = new Set(
      (params.excludeNames ?? []).map((n) => n.trim().toLowerCase())
    );

    const places: GooglePlace[] = [];
    const seenIds = new Set<string>();
    let firstCallFailed: string | null = null;

    // Cada variação é uma chamada cobrada, então só avançamos para a próxima
    // enquanto faltarem empresas para o pedido.
    for (const currentQuery of queries.slice(0, MAX_QUERY_VARIANTS)) {
      if (places.length >= wanted) break;
      let pageToken: string | undefined;

      do {
        const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": [
              "places.id",
              "places.displayName",
              "places.formattedAddress",
              "places.nationalPhoneNumber",
              "places.internationalPhoneNumber",
              "places.websiteUri",
              "places.rating",
              "places.userRatingCount",
              "places.googleMapsUri",
              "places.businessStatus",
              "places.types",
              "places.primaryType",
              "places.regularOpeningHours.weekdayDescriptions",
              "nextPageToken",
            ].join(","),
          },
          body: JSON.stringify({
            textQuery: currentQuery,
            pageSize: PAGE_SIZE,
            languageCode: "pt-BR",
            ...(regionCode ? { regionCode } : {}),
            ...(mapping?.includedType ? { includedType: mapping.includedType } : {}),
            ...(pageToken ? { pageToken } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          // Guarda o motivo da primeira falha: se nenhuma variação trouxer
          // nada, é ele que explica o porquê ao usuário.
          firstCallFailed ??= await describeApiError(res);
          break;
        }

        const data = (await res.json()) as { places?: GooglePlace[]; nextPageToken?: string };
        for (const p of data.places ?? []) {
          if (seenIds.has(p.id) || excluded.has(p.id)) continue;
          const name = p.displayName?.text?.trim().toLowerCase();
          if (name && excludedNames.has(name)) continue;
          seenIds.add(p.id);
          places.push(p);
        }
        pageToken = data.nextPageToken;
      } while (pageToken && places.length < wanted);
    }

    if (places.length === 0 && firstCallFailed) throw new Error(firstCallFailed);

    const matching = places.filter((p) => matchesNiche(p, params.niche));
    if (matching.length === 0 && places.length > 0) {
      // O Google devolveu resultados, mas nenhum do tipo esperado para o
      // nicho. Sem esta mensagem o job terminaria com zero leads e nenhuma
      // explicação de por quê.
      throw new Error(
        `O Google encontrou ${places.length} lugares em ${local}, mas nenhum classificado como ${nicheLabel}. Tente um nicho mais próximo do vocabulário do Google Maps.`
      );
    }

    return shuffle(matching)
      .slice(0, wanted)
      .map((p): RawLead => {
        const uri = p.websiteUri;
        const isSocial = Boolean(uri && SOCIAL_HOSTS.test(uri));
        const website = uri && !isSocial ? uri : undefined;

        let instagram: string | undefined;
        let facebook: string | undefined;
        let whatsapp: string | undefined;
        let socialLink: string | undefined;
        if (uri && isSocial) {
          instagram = extractInstagramHandle(uri) ?? undefined;
          whatsapp = extractWhatsapp(uri) ?? undefined;
          if (/facebook\.com/i.test(uri)) {
            facebook = uri.split("facebook.com/")[1]?.replace(/[/?].*$/, "") || undefined;
          }
          if (AGGREGATOR_HOSTS.test(uri)) socialLink = uri;
        }

        return {
          company_name: p.displayName?.text ?? "Empresa sem nome",
          segment: nicheLabel,
          phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
          website,
          instagram,
          facebook,
          whatsapp,
          social_link: socialLink,
          country: params.country,
          state: params.state,
          city: params.city,
          address: p.formattedAddress,
          reviews_count: p.userRatingCount,
          rating: p.rating,
          opening_hours: p.regularOpeningHours?.weekdayDescriptions?.[0],
          source: "google_places",
          source_id: p.id,
          google_maps_url: p.googleMapsUri,
          website_quality: website ? "desconhecido" : "nenhum",
          instagram_active: Boolean(instagram),
          marketing_signals: false,
          business_active: p.businessStatus !== "CLOSED_PERMANENTLY" && p.businessStatus !== "CLOSED_TEMPORARILY",
          catalog_size: "desconhecido",
        };
      });
  }
}
