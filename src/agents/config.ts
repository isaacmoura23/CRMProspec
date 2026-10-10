import { z } from "zod";
import { normalizeBrazilianPhone } from "@/lib/outreach-policy";
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
/* Agente 4 — Vendedor (WhatsApp)                                      */
/* ------------------------------------------------------------------ */

export interface SellerConfig {
  /** Dias em que pode enviar (ISO: 1 = segunda … 7 = domingo). */
  send_days: number[];
  /** Horário de envio no fuso de São Paulo: de `start_hour` (inclusive) a `end_hour` (exclusive). */
  start_hour: number;
  end_hour: number;
  /** Máximo de mensagens por dia que o número chega a enviar. */
  daily_cap_max: number;
  /** Sobe o teto por semana (10, 20, 30…) até o máximo, em vez de começar no máximo. */
  warmup: boolean;
  /** Espera aleatória entre dois envios, em segundos. */
  min_gap_seconds: number;
  max_gap_seconds: number;
  /** Dias de espera depois do 1º e do 2º toque (no máximo 3 toques por lead). */
  touch_spacing_days: number[];
  max_touches: number;
  /** Só leads com score a partir daqui recebem abordagem. */
  min_lead_score: number;
  /** Consultas "este número tem WhatsApp?" por dia. */
  lookups_per_day: number;
  /** Com o modo de aprovação, quantos pedidos podem esperar ao mesmo tempo. */
  max_pending_approvals: number;
  /** Só aborda leads criados pelos agentes (não os que você cadastrou à mão). */
  only_agent_leads: boolean;

  /* Conversa: horários de reunião que o agente pode propor e aviso ao dono. */
  /** Dias em que aceita reunião (ISO: 1 = segunda … 7 = domingo). */
  meeting_days: number[];
  meeting_start_hour: number;
  meeting_end_hour: number;
  /** Antecedência mínima entre a resposta do lead e o primeiro horário proposto. */
  meeting_min_notice_hours: number;
  meeting_duration_min: number;
  /** WhatsApp pessoal do dono (E.164) que recebe o aviso de reunião marcada; `null` = sem aviso por WhatsApp. */
  owner_phone: string | null;
  /**
   * Só aborda quem já tem dossiê (Agente 3), para a mensagem falar de algo comprovado.
   * Vale só enquanto o Agente 3 estiver ligado: pausá-lo libera o Vendedor.
   */
  require_dossier: boolean;
}

export const SELLER_DEFAULTS: SellerConfig = {
  send_days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 18,
  daily_cap_max: 40,
  warmup: true,
  min_gap_seconds: 60,
  max_gap_seconds: 180,
  touch_spacing_days: [3, 4],
  max_touches: 3,
  min_lead_score: 50,
  lookups_per_day: 60,
  max_pending_approvals: 10,
  only_agent_leads: true,
  meeting_days: [2, 3, 4],
  meeting_start_hour: 10,
  meeting_end_hour: 17,
  meeting_min_notice_hours: 24,
  meeting_duration_min: 20,
  owner_phone: null,
  require_dossier: true,
};

export function normalizeSellerConfig(raw: unknown): SellerConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = SELLER_DEFAULTS;

  const days = Array.isArray(r.send_days)
    ? [...new Set(r.send_days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort()
    : d.send_days;
  const start = clampInt(r.start_hour, 0, 23, d.start_hour);
  // O fim nunca antes do início: uma janela vazia seria um "pausado" disfarçado.
  const end = Math.max(start + 1, clampInt(r.end_hour, 1, 24, d.end_hour));
  const minGap = clampInt(r.min_gap_seconds, 10, 3600, d.min_gap_seconds);
  const maxGap = Math.max(minGap, clampInt(r.max_gap_seconds, 10, 7200, d.max_gap_seconds));
  const spacing = Array.isArray(r.touch_spacing_days)
    ? r.touch_spacing_days.map((n) => clampInt(n, 1, 30, 3)).slice(0, 2)
    : d.touch_spacing_days;

  const meetingDays = Array.isArray(r.meeting_days)
    ? [...new Set(r.meeting_days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort()
    : d.meeting_days;
  const meetingStart = clampInt(r.meeting_start_hour, 0, 23, d.meeting_start_hour);
  const meetingEnd = Math.max(meetingStart + 1, clampInt(r.meeting_end_hour, 1, 24, d.meeting_end_hour));

  return {
    send_days: days,
    start_hour: start,
    end_hour: end,
    daily_cap_max: clampInt(r.daily_cap_max, 0, 200, d.daily_cap_max),
    warmup: r.warmup === undefined ? d.warmup : r.warmup !== false,
    min_gap_seconds: minGap,
    max_gap_seconds: maxGap,
    touch_spacing_days: spacing.length > 0 ? spacing : d.touch_spacing_days,
    max_touches: clampInt(r.max_touches, 1, 3, d.max_touches),
    min_lead_score: clampInt(r.min_lead_score, 0, 100, d.min_lead_score),
    lookups_per_day: clampInt(r.lookups_per_day, 0, 500, d.lookups_per_day),
    max_pending_approvals: clampInt(r.max_pending_approvals, 1, 50, d.max_pending_approvals),
    only_agent_leads: r.only_agent_leads === undefined ? d.only_agent_leads : r.only_agent_leads !== false,
    meeting_days: meetingDays,
    meeting_start_hour: meetingStart,
    meeting_end_hour: meetingEnd,
    meeting_min_notice_hours: clampInt(r.meeting_min_notice_hours, 1, 168, d.meeting_min_notice_hours),
    meeting_duration_min: clampInt(r.meeting_duration_min, 10, 120, d.meeting_duration_min),
    owner_phone: normalizeBrazilianPhone(typeof r.owner_phone === "string" ? r.owner_phone : null),
    require_dossier: r.require_dossier === undefined ? d.require_dossier : r.require_dossier !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Agente 3 — Analista de Presença Digital                             */
/* ------------------------------------------------------------------ */

export interface PresenceConfig {
  /** Dossiês montados por dia (cada um faz algumas requisições a sites públicos). */
  dossiers_per_day: number;
  /** Dias até refazer o dossiê de um lead. */
  refresh_days: number;
  /** Só monta dossiê para leads com score a partir daqui. */
  min_lead_score: number;
  /** Só leads criados pelos agentes. */
  only_agent_leads: boolean;
  /** Espera entre duas requisições ao mesmo dossiê, para não martelar os sites. */
  fetch_delay_ms: number;
  /**
   * Avaliação visual do site (capturas desktop e celular lidas por um modelo com visão).
   * Exige Chrome ou Edge instalado e ANTHROPIC_API_KEY; desligada por padrão.
   */
  visual: boolean;
}

export const PRESENCE_DEFAULTS: PresenceConfig = {
  dossiers_per_day: 30,
  refresh_days: 30,
  min_lead_score: 40,
  only_agent_leads: true,
  fetch_delay_ms: 1_500,
  visual: false,
};

export function normalizePresenceConfig(raw: unknown): PresenceConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = PRESENCE_DEFAULTS;
  return {
    dossiers_per_day: clampInt(r.dossiers_per_day, 0, 300, d.dossiers_per_day),
    refresh_days: clampInt(r.refresh_days, 1, 180, d.refresh_days),
    min_lead_score: clampInt(r.min_lead_score, 0, 100, d.min_lead_score),
    only_agent_leads: r.only_agent_leads === undefined ? d.only_agent_leads : r.only_agent_leads !== false,
    fetch_delay_ms: clampInt(r.fetch_delay_ms, 0, 10_000, d.fetch_delay_ms),
    visual: r.visual === true,
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
