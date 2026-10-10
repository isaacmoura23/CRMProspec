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
  return targets.slice(0, 5).map((t) => ({
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
