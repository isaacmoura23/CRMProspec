import { z } from "zod";
import type { AgentMode } from "@/types/agents";
import type { SearchParams } from "@/types";

/**
 * Configuração de cada agente.
 *
 * Sem `server-only`: os formulários da tela importam os esquemas e os padrões.
 * O `config` gravado em `agent_settings` é sempre passado por `normalize*`, que
 * preenche o que faltar e limita cada valor — uma linha antiga, editada à mão
 * ou de uma versão anterior nunca chega crua ao agente.
 */

/** Nasce em aprovação: nada gasta cota paga sem um clique até o dono liberar. */
export const DEFAULT_AGENT_MODE: AgentMode = "aprovacao";

/** Teto de cidades por agente: cada cidade multiplica o número de sondagens pagas. */
export const MAX_CITIES = 8;

export const citySchema = z.object({
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(60).optional(),
  country: z.string().trim().min(2).max(60).default("Brasil"),
});
export type CityConfig = z.infer<typeof citySchema>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeCities(value: unknown): CityConfig[] {
  if (!Array.isArray(value)) return [];
  const out: CityConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = citySchema.safeParse(item);
    if (!parsed.success) continue;
    const key = `${parsed.data.city.toLowerCase()}|${parsed.data.country.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= MAX_CITIES) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Agente 1 — Analista de Nicho                                        */
/* ------------------------------------------------------------------ */

export interface NicheAnalystConfig {
  cities: CityConfig[];
  /** Chaves de nicho a analisar; vazio = todos os que a fonte entende. */
  niches: string[];
  /** Empresas pedidas à fonte por nicho × cidade. Uma página = 20. */
  sample_size: number;
  /** Sites visitados por sondagem para medir se são fracos (cada um leva segundos). */
  probe_sites: number;
  /** Teto diário de requisições cobradas ao Google Places. */
  max_places_requests_day: number;
}

export const NICHE_ANALYST_DEFAULTS: NicheAnalystConfig = {
  cities: [],
  niches: [],
  sample_size: 20,
  probe_sites: 8,
  max_places_requests_day: 40,
};

export function normalizeNicheAnalystConfig(raw: unknown): NicheAnalystConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = NICHE_ANALYST_DEFAULTS;
  return {
    cities: normalizeCities(r.cities),
    niches: Array.isArray(r.niches)
      ? [...new Set(r.niches.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length < 60))]
      : d.niches,
    sample_size: clampInt(r.sample_size, 5, 60, d.sample_size),
    probe_sites: clampInt(r.probe_sites, 0, 20, d.probe_sites),
    max_places_requests_day: clampInt(r.max_places_requests_day, 0, 500, d.max_places_requests_day),
  };
}

/* ------------------------------------------------------------------ */
/* Agente 2 — Prospectador                                             */
/* ------------------------------------------------------------------ */

export interface ProspectorConfig {
  /** Leads pedidos por execução. */
  quantity_per_run: number;
  /** Teto diário de leads novos criados pelo agente. */
  daily_leads_cap: number;
  /** Teto diário de requisições cobradas ao Google Places. */
  max_places_requests_day: number;
  /** Só nichos com score a partir daqui entram sozinhos na fila. */
  min_niche_score: number;
  /** Dias até voltar a prospectar o mesmo nicho × cidade. */
  cooldown_days: number;
  filters: SearchParams["filters"];
}

export const PROSPECTOR_DEFAULTS: ProspectorConfig = {
  quantity_per_run: 20,
  daily_leads_cap: 40,
  max_places_requests_day: 60,
  min_niche_score: 40,
  cooldown_days: 7,
  // O alvo do negócio: quem não tem site ou tem um site fraco.
  filters: { weakWebsite: true, activeBusiness: true },
};

const FILTER_KEYS = [
  "hasPhone",
  "hasWhatsapp",
  "hasInstagram",
  "hasEmail",
  "noWebsite",
  "hasWebsite",
  "badWebsite",
  "weakWebsite",
  "activeBusiness",
  "hasReviews",
  "strongSocial",
] as const;

export function normalizeFilters(raw: unknown): SearchParams["filters"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: SearchParams["filters"] = {};
  for (const key of FILTER_KEYS) if (r[key] === true) out[key] = true;
  return out;
}

export function normalizeProspectorConfig(raw: unknown): ProspectorConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = PROSPECTOR_DEFAULTS;
  const hasFilters = r.filters && typeof r.filters === "object";
  return {
    quantity_per_run: clampInt(r.quantity_per_run, 1, 100, d.quantity_per_run),
    daily_leads_cap: clampInt(r.daily_leads_cap, 0, 500, d.daily_leads_cap),
    max_places_requests_day: clampInt(r.max_places_requests_day, 0, 1000, d.max_places_requests_day),
    min_niche_score: clampInt(r.min_niche_score, 0, 100, d.min_niche_score),
    cooldown_days: clampInt(r.cooldown_days, 0, 90, d.cooldown_days),
    filters: hasFilters ? normalizeFilters(r.filters) : { ...d.filters },
  };
}
