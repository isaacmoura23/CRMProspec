import type { LeadProvider } from "@/providers/types";
import { DirectoryProvider } from "@/providers/directory-provider";
import { GooglePlacesProvider } from "@/providers/google-places-provider";

/**
 * Registry de fontes de prospecção.
 * A ordem importa: a primeira fonte configurada é usada como principal.
 * Novas fontes (diretórios pagos, webhooks, bases próprias) entram aqui.
 */
const PROVIDERS: LeadProvider[] = [new GooglePlacesProvider(), new DirectoryProvider()];

export function getActiveProvider(): LeadProvider {
  return PROVIDERS.find((p) => p.isConfigured()) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

export function listProviders(): Array<{ id: string; name: string; configured: boolean }> {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured() }));
}
