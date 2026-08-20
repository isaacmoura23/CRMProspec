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
    const query = `${nicheLabel} em ${params.city}${params.state ? `, ${params.state}` : ""}, ${params.country}`;
    const regionCode = REGION_CODES[params.country.trim().toLowerCase()];
    const wanted = Math.min(params.quantity, MAX_RESULTS);
    const excluded = new Set(params.excludeSourceIds ?? []);

    const places: GooglePlace[] = [];
    const seenIds = new Set<string>();
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
          textQuery: query,
          pageSize: PAGE_SIZE,
          languageCode: "pt-BR",
          ...(regionCode ? { regionCode } : {}),
          ...(mapping?.includedType ? { includedType: mapping.includedType } : {}),
          ...(pageToken ? { pageToken } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        // se a primeira página falhar, é erro real; páginas seguintes: usa o que já veio
        if (places.length === 0) throw new Error(`Google Places respondeu ${res.status}`);
        break;
      }

      const data = (await res.json()) as { places?: GooglePlace[]; nextPageToken?: string };
      for (const p of data.places ?? []) {
        if (seenIds.has(p.id) || excluded.has(p.id)) continue;
        seenIds.add(p.id);
        places.push(p);
      }
      pageToken = data.nextPageToken;
    } while (pageToken && places.length < wanted);

    return shuffle(places.filter((p) => matchesNiche(p, params.niche)))
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
