import "server-only";
import { getDb } from "@/lib/store";
import { NICHES } from "@/providers/directory-data";
import { scoreNiche } from "@/agents/niche/scoring";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import type { CityConfig } from "@/agents/config";
import { dayKey, spentToday } from "@/services/agents/log";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getNicheAnalystConfig } from "@/services/agents/settings";
import { probeSource } from "@/services/source-probe";
import type { NicheTarget } from "@/types/agents";

/**
 * Agente 1 — Analista de Nicho.
 *
 * Mede, em dados reais da fonte, em quais nichos × cidades há mais empresas
 * sem site ou com site fraco, e ranqueia com fatores explicáveis. Não decide
 * por opinião de modelo: a sondagem é contagem na fonte.
 */

export const NICHE_ANALYZE = "niche.analyze";
const VALIDITY_DAYS = 7;
/** Uma página do Text Search traz 20 empresas e cada página é uma requisição cobrada. */
const PAGE_SIZE = 20;

/** Nichos que o provedor entende (os mesmos do formulário de Prospectar). */
export const SUPPORTED_NICHES = NICHES.map((n) => ({ key: n.key, label: n.label }));

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function nicheTargetId(niche: string, city: string): string {
  return `nt_${niche}_${slug(city)}`;
}

function estimateRequests(sample: number, live: boolean): number {
  return live ? Math.max(1, Math.ceil(sample / PAGE_SIZE)) : 0;
}

interface Combo {
  niche: { key: string; label: string };
  city: CityConfig;
}

function combosFor(cities: CityConfig[], nicheKeys: string[]): Combo[] {
  const niches = nicheKeys.length
    ? SUPPORTED_NICHES.filter((n) => nicheKeys.includes(n.key))
    : SUPPORTED_NICHES;
  return cities.flatMap((city) => niches.map((niche) => ({ niche, city })));
}

/** Combinações sem análise válida primeiro: uma rodada interrompida pelo teto avança de onde parou. */
function orderByStaleness(combos: Combo[], targets: NicheTarget[], now: string): Combo[] {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const key = (c: Combo) => byId.get(nicheTargetId(c.niche.key, c.city.city))?.analyzed_at ?? "";
  const valid = (c: Combo) => {
    const t = byId.get(nicheTargetId(c.niche.key, c.city.city));
    return Boolean(t && t.valid_until > now);
  };
  return [...combos].sort((a, b) => {
    const va = valid(a) ? 1 : 0;
    const vb = valid(b) ? 1 : 0;
    if (va !== vb) return va - vb;
    return key(a).localeCompare(key(b));
  });
}

async function analyze(ctx: AgentTaskContext): Promise<void> {
  const cfg = await getNicheAnalystConfig();
  if (cfg.cities.length === 0) {
    throw new PermanentTaskError("Nenhuma cidade configurada. Cadastre ao menos uma em /agentes/niche-analyst.");
  }

  const repo = agentRepo();
  const now = new Date();
  const nowIso = now.toISOString();
  const priority = getDb().company_profile.priority_niches ?? [];
  const existing = await repo.list("niche_targets");
  const combos = orderByStaleness(combosFor(cfg.cities, cfg.niches), existing, nowIso);

  let requestsToday = await spentToday("niche-analyst", "places_requests");
  let analyzed = 0;
  let skippedByCap = 0;
  let live = false;
  let source = "";
  const failures: string[] = [];

  for (let i = 0; i < combos.length; i++) {
    if (await ctx.isCancelled()) break;
    const { niche, city } = combos[i]!;
    await ctx.progress(i, combos.length, `${niche.label} em ${city.city}`);

    // O teto vale por sondagem: estima o custo antes de gastar.
    const isLiveProvider = Boolean(process.env.GOOGLE_PLACES_API_KEY);
    const estimate = estimateRequests(cfg.sample_size, isLiveProvider);
    if (requestsToday + estimate > cfg.max_places_requests_day) {
      skippedByCap = combos.length - i;
      await ctx.log("warn", `Teto diário de requisições atingido (${requestsToday}/${cfg.max_places_requests_day}); ${skippedByCap} combinações ficam para amanhã.`);
      break;
    }

    let requests = 0;
    try {
      const probe = await probeSource({
        niche: niche.key,
        city: city.city,
        state: city.state,
        country: city.country,
        sample: cfg.sample_size,
        probeSites: cfg.probe_sites,
        onRequest: () => {
          requests += 1;
        },
      });
      live = probe.live;
      source = probe.provider;
      requestsToday += requests;
      await ctx.spend("places_requests", requests, `${niche.key} · ${city.city}`);

      const { score, factors, evidence } = scoreNiche({
        metrics: probe.metrics,
        sampleRequested: cfg.sample_size,
        nicheKey: niche.key,
        nicheLabel: niche.label,
        priorityNiches: priority,
        source: probe.provider,
      });

      const id = nicheTargetId(niche.key, city.city);
      const previous = existing.find((t) => t.id === id);
      const target: NicheTarget = {
        id,
        organization_id: orgId(),
        niche: niche.key,
        niche_label: niche.label,
        city: city.city,
        state: city.state ?? null,
        country: city.country,
        metrics: probe.metrics,
        score,
        factors,
        evidence,
        source: probe.provider,
        // Fixar/banir é decisão do dono: uma nova análise não a desfaz.
        status: previous?.status ?? "auto",
        analyzed_at: new Date().toISOString(),
        valid_until: new Date(Date.now() + VALIDITY_DAYS * 86_400_000).toISOString(),
        task_id: ctx.task.id,
      };
      await repo.upsert("niche_targets", target);
      analyzed += 1;
    } catch (err) {
      // Falha numa combinação (ex.: nicho sem tipo no Google) não derruba as outras.
      requestsToday += requests;
      await ctx.spend("places_requests", requests, `${niche.key} · ${city.city} (falhou)`);
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${niche.label} em ${city.city}: ${message}`);
      await ctx.log("warn", `Sondagem de ${niche.label} em ${city.city} falhou: ${message}`);
    }
  }

  await ctx.progress(combos.length, combos.length, "Concluído");
  ctx.setResult({
    analyzed,
    skipped_by_cap: skippedByCap,
    failed: failures.length,
    failures: failures.slice(0, 10),
    source,
    live,
    requests_today: requestsToday,
  });
  // Tudo falhou: é erro da tarefa (chave inválida, API desligada), não resultado.
  if (analyzed === 0 && failures.length > 0) {
    throw new PermanentTaskError(failures[0]!);
  }
}

async function plan(): Promise<PlannedTask[]> {
  const cfg = await getNicheAnalystConfig();
  if (cfg.cities.length === 0) return [];

  const targets = await agentRepo().list("niche_targets");
  const now = new Date().toISOString();
  const validIds = new Set(targets.filter((t) => t.valid_until > now).map((t) => t.id));
  const combos = combosFor(cfg.cities, cfg.niches);
  const missing = combos.filter((c) => !validIds.has(nicheTargetId(c.niche.key, c.city.city)));
  if (missing.length === 0) return [];

  return [
    {
      agent: "niche-analyst",
      kind: NICHE_ANALYZE,
      payload: {},
      dedupeKey: `${NICHE_ANALYZE}:${dayKey()}`,
      title: "Analisar nichos",
      detail: `${missing.length} de ${combos.length} combinações de nicho × cidade sem análise válida. Teto de ${cfg.max_places_requests_day} requisições ao Google por dia.`,
    },
  ];
}

export const nicheAnalyst: AgentDefinition = {
  id: "niche-analyst",
  name: "Analista de Nicho",
  description: "Mede na fonte quais nichos e cidades têm mais empresas sem site ou com site fraco e ranqueia com fatores explicáveis.",
  kinds: [NICHE_ANALYZE],
  plan,
};

export function registerNicheAnalystHandlers() {
  registerAgentHandler(NICHE_ANALYZE, analyze);
}
