"use server";

import { getAdminUser } from "@/lib/auth";
import { GooglePlacesProvider } from "@/providers/google-places-provider";

export interface ConnectionTest {
  ok: boolean;
  detail: string;
  samples?: string[];
}

/**
 * Faz uma busca real na Places API e devolve o que voltou.
 *
 * A tela antes reportava "conectada" só por existir a variável de ambiente,
 * o que é um indicador falso: a chave pode ser inválida, a API pode não
 * estar habilitada no projeto ou faltar faturamento — e nada disso aparece
 * até a primeira prospecção falhar.
 */
export async function testGooglePlaces(): Promise<ConnectionTest> {
  if (!(await getAdminUser())) {
    return { ok: false, detail: "Apenas owner ou admin podem testar integrações." };
  }

  const provider = new GooglePlacesProvider();
  if (!provider.isConfigured()) {
    return {
      ok: false,
      detail:
        "GOOGLE_PLACES_API_KEY não está definida no servidor. Defina a variável e reinicie a aplicação.",
    };
  }

  try {
    const results = await provider.search({
      niche: "restaurante",
      country: "Brasil",
      city: "São Paulo",
      quantity: 3,
      filters: {},
    });
    if (results.length === 0) {
      return { ok: false, detail: "A chave funciona, mas a busca de teste não retornou lugares." };
    }
    return {
      ok: true,
      detail: `Conectado. A busca de teste retornou ${results.length} lugares reais do Google Maps.`,
      samples: results.map((r) => r.company_name),
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Falha ao chamar a Places API." };
  }
}
