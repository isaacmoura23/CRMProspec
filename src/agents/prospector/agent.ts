import "server-only";
import { getDb } from "@/lib/store";
import { normalizeFilters } from "@/agents/config";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import { computeFetchTarget, executeProspecting, registerProspectingJob } from "@/jobs/prospecting";
import { getActiveProvider } from "@/providers/registry";
import { dayKey, spentToday } from "@/services/agents/log";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo } from "@/services/agents/repository";
import { getProspectorConfig } from "@/services/agents/settings";
import { SUPPORTED_NICHES } from "@/agents/niche/agent";
import { citySlug, scopeCities } from "@/data/br-cities";
import { orgId } from "@/services/agents/repository";
import type { ProspectCoverage } from "@/types/agents";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import type { SearchParams } from "@/types";

/**
 * Agente 2 — Prospectador.
 *
 * Transforma os nichos ranqueados pelo Agente 1 em leads novos: empresas sem
 * site ou com site fraco. Reaproveita o job de prospecção da tela de Prospectar
 * (busca, dedupe, enriquecimento, filtros, score e análise) — o que o agente
 * acrescenta é a decisão de onde prospectar e os tetos diários.
 */

export const PROSPECT_RUN = "prospect.run";
const PAGE_SIZE = 20;

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Leads criados por prospecção de agente ficam agrupados nesta campanha. */
export function agentCampaignName(nicheLabel: string, city: string): string {
  return `AgentOS · ${nicheLabel} · ${city}`;
}

export const AGENT_CAMPAIGN_PREFIX = "AgentOS · ";

/** Amanhã às 00:05 de São Paulo (UTC-3, sem horário de verão desde 2019). */
function nextDayStart(): Date {
  const [y, m, d] = dayKey().split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1, 3, 5, 0));
}

function ownerUserId(): string | null {
  const users = getDb().users;
  return users.find((u) => u.role === "owner")?.id ?? users[0]?.id ?? null;
}

interface ProspectPayload {
  niche: string;
  niche_label: string;
  city: string;
  state?: string;
  country: string;
  quantity?: number;
  filters?: SearchParams["filters"];
}

function readPayload(raw: Record<string, unknown>): ProspectPayload {
  const niche = typeof raw.niche === "string" ? raw.niche : "";
  const city = typeof raw.city === "string" ? raw.city : "";
  if (!niche || !city) throw new PermanentTaskError("Tarefa sem nicho ou cidade.");
  return {
    niche,
    niche_label: typeof raw.niche_label === "string" && raw.niche_label ? raw.niche_label : niche,
    city,
    state: typeof raw.state === "string" ? raw.state : undefined,
    country: typeof raw.country === "string" && raw.country ? raw.country : "Brasil",
    quantity: typeof raw.quantity === "number" ? raw.quantity : undefined,
    filters: raw.filters ? normalizeFilters(raw.filters) : undefined,
  };
}

async function run(ctx: AgentTaskContext): Promise<void> {
  const cfg = await getProspectorConfig();
  const p = readPayload(ctx.task.payload);

  // Tetos diários: ao estourar, a tarefa espera o dia seguinte em vez de falhar.
  const leadsLeft = cfg.daily_leads_cap - (await spentToday("prospector", "leads"));
  if (leadsLeft <= 0) {
    await ctx.log("warn", `Teto diário de leads atingido (${cfg.daily_leads_cap}); a tarefa fica para amanhã.`);
    ctx.reschedule(nextDayStart());
    return;
  }
  const quantity = Math.max(1, Math.min(p.quantity ?? cfg.quantity_per_run, leadsLeft));
  const filters = p.filters ?? cfg.filters;

  const provider = getActiveProvider();
  const live = provider.id === "google_places";
  // Pior caso de requisições cobradas desta busca: é o que o teto precisa cobrir.
  const worstCase = live ? Math.ceil(computeFetchTarget(quantity, filters, provider.id) / PAGE_SIZE) : 0;
  const placesLeft = cfg.max_places_requests_day - (await spentToday("prospector", "places_requests"));
  if (worstCase > placesLeft) {
    await ctx.log("warn", `Teto diário de requisições ao Google (${cfg.max_places_requests_day}) não comporta esta busca (até ${worstCase}); fica para amanhã.`);
    ctx.reschedule(nextDayStart());
    return;
  }

  // O job trabalha sobre os leads em memória: com Supabase, carrega os do banco antes.
  await ensureLeadsLoaded();

  const params: SearchParams = {
    niche: p.niche,
    country: p.country,
    state: p.state,
    city: p.city,
    quantity,
    filters,
    campaignName: agentCampaignName(p.niche_label, p.city),
  };
  const job = registerProspectingJob(params);
  await ctx.progress(0, quantity, `${p.niche_label} em ${p.city}`);

  let requests = 0;
  await executeProspecting(job, ownerUserId(), {
    onPlacesRequest: () => {
      requests += 1;
    },
  });

  await ctx.spend("places_requests", requests, `${p.niche} · ${p.city}`);
  await ctx.spend("leads", job.found_lead_ids.length, `${p.niche} · ${p.city}`);
  await ctx.progress(job.found_lead_ids.length, quantity, "Concluído");

  await recordCoverage({
    niche: p.niche,
    niche_label: p.niche_label,
    city: p.city,
    state: p.state ?? null,
    country: p.country,
    scanned: job.scanned ?? 0,
    found: job.found_lead_ids.length,
    filtered: job.filtered ?? 0,
    duplicates: job.duplicates,
    places_requests: requests,
  });

  ctx.setResult({
    job_id: job.id,
    niche: p.niche,
    city: p.city,
    requested: quantity,
    found: job.found_lead_ids.length,
    duplicates: job.duplicates,
    filtered: job.filtered ?? 0,
    filtered_by: job.filtered_by ?? {},
    scanned: job.scanned ?? 0,
    errors: job.errors.slice(0, 10),
    source: provider.id,
    live,
    places_requests: requests,
  });

  // A fonte não entregou nada e explicou o porquê: é falha da tarefa, com a causa.
  if (job.status === "failed") {
    throw new PermanentTaskError(job.errors[0] ?? "A prospecção falhou.");
  }
}

/** Soma o que esta execução varreu ao registro de cobertura do nicho × cidade. */
export async function recordCoverage(c: Omit<ProspectCoverage, "id" | "organization_id" | "runs" | "last_run_at" | "created_at" | "updated_at">, now: Date = new Date()): Promise<ProspectCoverage> {
  const repo = agentRepo();
  const id = `${c.niche}|${citySlug(c.city)}`;
  const iso = now.toISOString();
  const prev = await repo.get("prospect_coverage", id);
  const row: ProspectCoverage = {
    id,
    organization_id: orgId(),
    niche: c.niche,
    niche_label: c.niche_label,
    city: c.city,
    state: c.state,
    country: c.country,
    runs: (prev?.runs ?? 0) + 1,
    scanned: (prev?.scanned ?? 0) + c.scanned,
    found: (prev?.found ?? 0) + c.found,
    filtered: (prev?.filtered ?? 0) + c.filtered,
    duplicates: (prev?.duplicates ?? 0) + c.duplicates,
    places_requests: (prev?.places_requests ?? 0) + c.places_requests,
    last_run_at: iso,
    created_at: prev?.created_at ?? iso,
    updated_at: iso,
  };
  return repo.upsert("prospect_coverage", row);
}

/** Filtros da varredura: o alvo é SÓ empresa sem site (a ficha cujo "site" é uma rede social conta como sem site). */
export const SWEEP_FILTERS: NonNullable<SearchParams["filters"]> = { noWebsite: true, activeBusiness: true, hasPhone: true };

/**
 * Próximas células (nicho × cidade) da varredura: dos nichos de maior nota, a cidade que nunca foi
 * varrida (capitais antes) e, esgotadas, a varrida há mais tempo — sempre fora da carência.
 */
export async function sweepCells(cfg: { sweep_scope: Parameters<typeof scopeCities>[0]; sweep_niches: number; cooldown_days: number }, now: Date = new Date()): Promise<Array<{ niche: string; niche_label: string; city: string; state: string }>> {
  const repo = agentRepo();
  const nowIso = now.toISOString();
  const targets = (await repo.list("niche_targets")).filter((t) => t.status !== "banido" && t.valid_until > nowIso);
  const bestByNiche = new Map<string, number>();
  for (const t of targets) bestByNiche.set(t.niche, Math.max(bestByNiche.get(t.niche) ?? 0, t.score));
  const ranked = [...SUPPORTED_NICHES].sort((a, b) => (bestByNiche.get(b.key) ?? -1) - (bestByNiche.get(a.key) ?? -1));
  const niches = ranked.slice(0, cfg.sweep_niches);

  const coverage = new Map((await repo.list("prospect_coverage")).map((c) => [c.id, c]));
  const cooldownFrom = new Date(now.getTime() - cfg.cooldown_days * 86_400_000).toISOString();
  const cities = scopeCities(cfg.sweep_scope);
  const out: Array<{ niche: string; niche_label: string; city: string; state: string }> = [];
  for (const n of niches) {
    const order = cities
      .map((city, i) => ({ city, i, seen: coverage.get(`${n.key}|${citySlug(city.city)}`) }))
      .filter((x) => !x.seen || x.seen.last_run_at <= cooldownFrom)
      // Nunca varrida primeiro (na ordem da lista: capitais antes); depois a varrida há mais tempo.
      .sort((a, b) => Number(Boolean(a.seen)) - Number(Boolean(b.seen)) || (a.seen?.last_run_at ?? "").localeCompare(b.seen?.last_run_at ?? "") || a.i - b.i);
    const next = order[0];
    if (next) out.push({ niche: n.key, niche_label: n.label, city: next.city.city, state: next.city.state });
  }
  return out;
}

async function plan(): Promise<PlannedTask[]> {
  const cfg = await getProspectorConfig();
  const leadsLeft = cfg.daily_leads_cap - (await spentToday("prospector", "leads"));
  if (leadsLeft <= 0) return [];

  const repo = agentRepo();
  const now = new Date();
  const nowIso = now.toISOString();

  // Uma prospecção por vez: enquanto houver uma viva, não propõe outra.
  const recent = await repo.list("tasks", {
    where: { agent: "prospector", kind: PROSPECT_RUN },
    orderBy: "created_at",
    desc: true,
    limit: 200,
  });
  if (recent.some((t) => t.status === "pendente" || t.status === "processando")) return [];

  const cooldownFrom = new Date(now.getTime() - cfg.cooldown_days * 86_400_000).toISOString();
  const onCooldown = new Set(
    recent
      .filter((t) => t.status === "concluido" && (t.finished_at ?? "") > cooldownFrom)
      .map((t) => `${t.payload.niche}|${slug(String(t.payload.city ?? ""))}`)
  );

  const targets = (await repo.list("niche_targets"))
    .filter((t) => t.status !== "banido" && t.valid_until > nowIso)
    // Fixado vale mesmo abaixo da nota mínima: foi escolha do dono.
    .filter((t) => t.status === "fixado" || t.score >= cfg.min_niche_score)
    .filter((t) => !onCooldown.has(`${t.niche}|${slug(t.city)}`))
    .sort((a, b) => Number(b.status === "fixado") - Number(a.status === "fixado") || b.score - a.score);

  // Em ordem de prioridade: se o melhor já foi proposto ou recusado hoje, o
  // planejador cai para o seguinte (e só propõe um por passada).
  const quantity = Math.min(cfg.quantity_per_run, leadsLeft);
  const sweep: PlannedTask[] = [];
  if (cfg.sweep) {
    for (const cell of await sweepCells(cfg, now)) {
      sweep.push({
        agent: "prospector" as const,
        kind: PROSPECT_RUN,
        payload: { niche: cell.niche, niche_label: cell.niche_label, city: cell.city, state: cell.state, country: "Brasil", quantity, filters: SWEEP_FILTERS, sweep: true },
        dedupeKey: `${PROSPECT_RUN}:${cell.niche}:${slug(cell.city)}:${dayKey()}`,
        title: `Varredura: ${quantity} empresas sem site de ${cell.niche_label} em ${cell.city}`,
        detail: `Cidade ainda não varrida para este nicho (varredura do Brasil). Restam ${leadsLeft} leads no teto de hoje.`,
      });
    }
  }
  const ranked: PlannedTask[] = targets.slice(0, 5).map((t) => ({
    agent: "prospector" as const,
    kind: PROSPECT_RUN,
    payload: {
      niche: t.niche,
      niche_label: t.niche_label,
      city: t.city,
      state: t.state ?? undefined,
      country: t.country,
      quantity,
    },
    dedupeKey: `${PROSPECT_RUN}:${t.niche}:${slug(t.city)}:${dayKey()}`,
    title: `Prospectar ${quantity} leads de ${t.niche_label} em ${t.city}`,
    detail: `Score do nicho: ${t.score}${t.status === "fixado" ? " (fixado por você)" : ""}. Restam ${leadsLeft} leads no teto de hoje.`,
  }));
  const seen = new Set<string>();
  return [...ranked, ...sweep].filter((t) => (seen.has(t.dedupeKey) ? false : (seen.add(t.dedupeKey), true)));
}

export const prospector: AgentDefinition = {
  id: "prospector",
  name: "Prospectador",
  description: "Busca empresas sem site ou com site fraco nos nichos que o Analista de Nicho ranqueou e as cadastra como leads.",
  kinds: [PROSPECT_RUN],
  plan,
};

export function registerProspectorHandlers() {
  registerAgentHandler(PROSPECT_RUN, run);
}
