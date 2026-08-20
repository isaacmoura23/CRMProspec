import type { RawLead, SearchParams } from "@/types";
import type { LeadProvider } from "@/providers/types";

/**
 * Provider Google Places (Places API — Text Search).
 * Ativado quando GOOGLE_PLACES_API_KEY está configurada no servidor.
 */
export class GooglePlacesProvider implements LeadProvider {
  id = "google_places";
  name = "Google Places";

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_PLACES_API_KEY);
  }

  async search(params: SearchParams): Promise<RawLead[]> {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) return [];

    const query = `${params.niche} em ${params.city}${params.state ? `, ${params.state}` : ""}, ${params.country}`;

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
          "places.regularOpeningHours.weekdayDescriptions",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: Math.min(params.quantity, 20),
        languageCode: "pt-BR",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Google Places respondeu ${res.status}`);
    }

    const data = (await res.json()) as {
      places?: Array<{
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
        regularOpeningHours?: { weekdayDescriptions?: string[] };
      }>;
    };

    return (data.places ?? []).map((p): RawLead => {
      const website = p.websiteUri;
      const isSocialOnly =
        website && /instagram\.com|facebook\.com|linktr\.ee|wa\.me/.test(website);
      return {
        company_name: p.displayName?.text ?? "Empresa sem nome",
        segment: params.niche,
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber,
        website: isSocialOnly ? undefined : website,
        instagram: isSocialOnly && website?.includes("instagram.com")
          ? `@${website.split("instagram.com/")[1]?.replace(/\/.*$/, "")}`
          : undefined,
        country: params.country,
        state: params.state,
        city: params.city,
        address: p.formattedAddress,
        reviews_count: p.userRatingCount,
        rating: p.rating,
        opening_hours: p.regularOpeningHours?.weekdayDescriptions?.[0],
        source: "google_places",
        source_id: p.id,
        website_quality: website && !isSocialOnly ? "desconhecido" : "nenhum",
        instagram_active: false,
        marketing_signals: false,
        business_active: p.businessStatus !== "CLOSED_PERMANENTLY",
        catalog_size: "desconhecido",
      };
    });
  }
}
