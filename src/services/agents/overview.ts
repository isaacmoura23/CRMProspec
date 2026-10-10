import "server-only";
import { AGENTS } from "@/agents/registry";
import { AGENT_CAMPAIGN_PREFIX } from "@/agents/prospector/agent";
import { getDb } from "@/lib/store";
import { dayKey } from "@/services/agents/log";
import { agentRepo, agentStorageMode } from "@/services/agents/repository";
import { getAgentMode, getSettingsRow, isGloballyEnabled } from "@/services/agents/settings";
import type { AgentEvent, AgentId, AgentMode, AgentTask, Approval, NicheTarget } from "@/types/agents";
import type { LeadStatus } from "@/types";

/**
 * Leitura agregada para o dashboard. Tudo vem de contagem no banco: sem dado,
 * o número é zero e a tela mostra estado vazio — nunca um valor simulado.
 */

/** Batimento mais antigo que isto = runner considerado fora do ar (o ciclo é de 10 s). */
export const RUNNER_ALIVE_WINDOW_MS = 30_000;

export interface RunnerStatus {
  alive: boolean;
  lastBeatAt: string | null;
  startedAt: string | null;
  instance: string | null;
}

export interface AgentSummary {
  id: AgentId;
  name: string;
  description: string;
  mode: AgentMode;
  pending: number;
  running: number;
  failedLast24h: number;
  completedLast24h: number;
  lastRun: { kind: string; status: AgentTask["status"]; at: string; error: string | null } | null;
  spent: { places_requests: number; leads: number; whatsapp_lookups: number };
}

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
  hint: string;
}

export interface AgentsOverview {
  storage: "supabase" | "local";
  globalEnabled: boolean;
  runner: RunnerStatus;
  agents: AgentSummary[];
  funnel: FunnelStep[];
  statusCounts: Partial<Record<LeadStatus, number>>;
  approvalsPending: number;
  recentEvents: AgentEvent[];
}

export async function getRunnerStatus(): Promise<RunnerStatus> {
  const beats = await agentRepo().list("heartbeats", { orderBy: "beat_at", desc: true, limit: 1 });
  const last = beats[0];
  if (!last) return { alive: false, lastBeatAt: null, startedAt: null, instance: null };
  return {
    alive: Date.now() - Date.parse(last.beat_at) < RUNNER_ALIVE_WINDOW_MS,
    lastBeatAt: last.beat_at,
    startedAt: last.started_at,
    instance: last.instance,
  };
}

export async function getAgentsOverview(): Promise<AgentsOverview> {
  const repo = agentRepo();
  const day = dayKey();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const nowIso = new Date().toISOString();

  const [globalEnabled, runner, tasks, spend, approvals, targets, events] = await Promise.all([
    isGloballyEnabled(),
    getRunnerStatus(),
    repo.list("tasks", { orderBy: "created_at", desc: true, limit: 300 }),
    repo.list("spend", { where: { day } }),
    repo.list("approvals", { where: { status: "pendente" } }),
    repo.list("niche_targets"),
    repo.list("events", { orderBy: "created_at", desc: true, limit: 15 }),
  ]);

  const agents: AgentSummary[] = await Promise.all(
    AGENTS.map(async (a) => {
      const mine = tasks.filter((t) => t.agent === a.id);
      const last = mine.find((t) => t.status !== "pendente") ?? mine[0];
      const sum = (kind: "places_requests" | "leads" | "whatsapp_lookups") =>
        spend.filter((s) => s.agent === a.id && s.kind === kind).reduce((n, s) => n + s.amount, 0);
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        mode: await getAgentMode(a.id),
        pending: mine.filter((t) => t.status === "pendente").length,
        running: mine.filter((t) => t.status === "processando").length,
        failedLast24h: mine.filter((t) => t.status === "falhou" && (t.finished_at ?? "") > since).length,
        completedLast24h: mine.filter((t) => t.status === "concluido" && (t.finished_at ?? "") > since).length,
        lastRun: last
          ? { kind: last.kind, status: last.status, at: last.finished_at ?? last.updated_at, error: last.last_error }
          : null,
        spent: { places_requests: sum("places_requests"), leads: sum("leads"), whatsapp_lookups: sum("whatsapp_lookups") },
      };
    })
  );

  // Funil: tudo contado dos dados reais do CRM.
  const db = getDb();
  const agentCampaigns = new Set(db.campaigns.filter((c) => c.name.startsWith(AGENT_CAMPAIGN_PREFIX)).map((c) => c.id));
  const agentLeads = db.leads.filter((l) => !l.archived && l.campaign_id && agentCampaigns.has(l.campaign_id));
  const statusCounts: Partial<Record<LeadStatus, number>> = {};
  for (const l of agentLeads) statusCounts[l.status] = (statusCounts[l.status] ?? 0) + 1;
  const reached = (...statuses: LeadStatus[]) => agentLeads.filter((l) => statuses.includes(l.status)).length;
  const validTargets = targets.filter((t) => t.valid_until > nowIso && t.status !== "banido");

  const funnel: FunnelStep[] = [
    { key: "niches", label: "Nichos ranqueados", value: validTargets.length, hint: "Com análise válida (7 dias), sem os banidos." },
    { key: "leads", label: "Leads criados pelos agentes", value: agentLeads.length, hint: "Campanhas “AgentOS · …”." },
    { key: "qualified", label: "Qualificados", value: reached("qualificado", "pronto_contato"), hint: "Prontos para abordagem." },
    {
      key: "contacted",
      label: "Contatados",
      value: reached("contatado", "respondeu", "interessado", "demo", "reuniao", "proposta", "negociacao", "fechado"),
      hint: "Etapas a partir de “contatado”.",
    },
    { key: "meetings", label: "Reuniões", value: reached("reuniao", "proposta", "negociacao", "fechado"), hint: "Reunião marcada ou além." },
  ];

  return {
    storage: agentStorageMode(),
    globalEnabled,
    runner,
    agents,
    funnel,
    statusCounts,
    approvalsPending: approvals.length,
    recentEvents: events,
  };
}

export interface AgentDetail {
  summary: AgentSummary;
  settingsUpdatedAt: string;
  config: Record<string, unknown>;
  tasks: AgentTask[];
  events: AgentEvent[];
  approvals: Approval[];
  targets: NicheTarget[];
}

export async function getAgentDetail(id: AgentId): Promise<AgentDetail | null> {
  const overview = await getAgentsOverview();
  const summary = overview.agents.find((a) => a.id === id);
  if (!summary) return null;
  const repo = agentRepo();
  const [row, tasks, events, approvals, targets] = await Promise.all([
    getSettingsRow(id),
    repo.list("tasks", { where: { agent: id }, orderBy: "created_at", desc: true, limit: 20 }),
    repo.list("events", { where: { agent: id }, orderBy: "created_at", desc: true, limit: 30 }),
    repo.list("approvals", { where: { agent: id }, orderBy: "created_at", desc: true, limit: 10 }),
    id === "niche-analyst" || id === "prospector" ? repo.list("niche_targets") : Promise.resolve([]),
  ]);
  return {
    summary,
    settingsUpdatedAt: row.updated_at,
    config: row.config,
    tasks,
    events,
    approvals,
    targets: [...targets].sort((a, b) => b.score - a.score),
  };
}

export async function listApprovals(): Promise<{ pending: Approval[]; history: Approval[] }> {
  const all = await agentRepo().list("approvals", { orderBy: "created_at", desc: true, limit: 100 });
  return {
    pending: all.filter((a) => a.status === "pendente"),
    history: all.filter((a) => a.status !== "pendente").slice(0, 30),
  };
}
