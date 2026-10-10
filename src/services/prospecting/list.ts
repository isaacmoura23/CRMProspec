import "server-only";
import { scopeCities } from "@/data/br-cities";
import { getDb } from "@/lib/store";
import { agentRepo } from "@/services/agents/repository";
import { getProspectorConfig } from "@/services/agents/settings";
import { agentCampaignIdSet } from "@/services/presence/build";
import type { ProspectCoverage } from "@/types/agents";

/**
 * "Lista de prospecção": as empresas SEM SITE que o Prospectador encontrou, com o que
 * o dono precisa para abordar — nome, telefone, Instagram e o link do Google Maps — e
 * o registro de cobertura da varredura.
 *
 * Nada aqui é inventado: o Instagram só aparece quando foi encontrado, e a origem dele
 * é dita. A ficha do Google Maps não tem campo de Instagram; ele só chega quando o campo
 * "site" da ficha aponta para o perfil (e por isso a empresa conta como "sem site").
 */

export interface ProspectRow {
  id: string;
  name: string;
  phone: string | null;
  instagram: string | null;
  instagram_origin: string | null;
  maps_url: string | null;
  niche: string;
  city: string;
  state: string | null;
  found_at: string;
  /** Dado de demonstração (domínios e perfis fictícios). */
  demo: boolean;
}

/** Empresas sem site criadas pelos agentes, da mais nova à mais antiga. */
export function prospectRows(): ProspectRow[] {
  const db = getDb();
  const campaigns = agentCampaignIdSet();
  return db.leads
    .filter((l) => !l.archived && !l.website && l.campaign_id !== null && campaigns.has(l.campaign_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((l) => ({
      id: l.id,
      name: l.company_name,
      phone: l.phone ?? null,
      instagram: l.instagram ?? null,
      instagram_origin: l.instagram ? (l.source === "google_places" ? "campo \"site\" da ficha do Google Maps" : l.source === "demo" || l.source === "diretorio" ? "dado de demonstração" : "cadastro") : null,
      maps_url: l.google_maps_url ?? null,
      niche: l.segment,
      city: l.city,
      state: l.state ?? null,
      found_at: l.created_at,
      demo: l.source === "demo" || l.source === "diretorio",
    }));
}

/** Só endereços http(s) viram link; o que veio de fora não pode ser `javascript:`. */
export const safeHttpUrl = (u: string | null): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

/** CSV com ponto e vírgula e BOM (abre direto no Excel em pt-BR), neutralizando injeção de fórmula. */
export function prospectCsv(rows: ProspectRow[]): string {
  const esc = (v: string | null) => {
    if (v === null || v === undefined) return "";
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ["empresa", "telefone", "instagram", "origem_do_instagram", "google_maps", "nicho", "cidade", "estado", "encontrado_em", "demonstracao"];
  const lines = rows.map((r) => [r.name, r.phone, r.instagram, r.instagram_origin, safeHttpUrl(r.maps_url), r.niche, r.city, r.state, r.found_at, r.demo ? "sim" : "não"].map((v) => esc(v)).join(";"));
  return `﻿${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

export interface CoverageSummary {
  scope: "capitais" | "principais";
  sweepOn: boolean;
  citiesInScope: number;
  /** Cidades distintas já varridas (para algum nicho). */
  citiesSwept: number;
  cells: number;
  found: number;
  requests: number;
  byNiche: Array<{ niche: string; label: string; cities: number; found: number }>;
  recent: ProspectCoverage[];
}

export async function coverageSummary(): Promise<CoverageSummary> {
  const [cfg, rows] = await Promise.all([getProspectorConfig(), agentRepo().list("prospect_coverage", { orderBy: "last_run_at", desc: true })]);
  const byNiche = new Map<string, { label: string; cities: Set<string>; found: number }>();
  for (const r of rows) {
    const e = byNiche.get(r.niche) ?? { label: r.niche_label, cities: new Set<string>(), found: 0 };
    e.cities.add(r.city);
    e.found += r.found;
    byNiche.set(r.niche, e);
  }
  return {
    scope: cfg.sweep_scope,
    sweepOn: cfg.sweep,
    citiesInScope: scopeCities(cfg.sweep_scope).length,
    citiesSwept: new Set(rows.map((r) => r.city)).size,
    cells: rows.length,
    found: rows.reduce((n, r) => n + r.found, 0),
    requests: rows.reduce((n, r) => n + r.places_requests, 0),
    byNiche: [...byNiche.entries()].map(([niche, v]) => ({ niche, label: v.label, cities: v.cities.size, found: v.found })).sort((a, b) => b.cities - a.cities),
    recent: rows.slice(0, 12),
  };
}
