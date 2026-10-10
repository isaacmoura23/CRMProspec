"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  citySchema,
  MAX_CITIES,
  normalizeFilters,
  normalizeNicheAnalystConfig,
  normalizeProspectorConfig,
} from "@/agents/config";
import { NICHE_ANALYZE, SUPPORTED_NICHES } from "@/agents/niche/agent";
import { PROSPECT_RUN } from "@/agents/prospector/agent";
import { getAdminUser, getWriterUser } from "@/lib/auth";
import { ADMIN_DENIED, WRITE_DENIED } from "@/lib/permissions";
import { decideApproval } from "@/services/agents/approvals";
import { logAgentEvent } from "@/services/agents/log";
import { cancelAgentTask, enqueueAgentTask } from "@/services/agents/queue";
import { agentRepo } from "@/services/agents/repository";
import {
  getAgentMode,
  getNicheAnalystConfig,
  isGloballyEnabled,
  saveSettings,
  setGloballyEnabled,
} from "@/services/agents/settings";
import { AGENT_MODES, isAgentId, type AgentId } from "@/types/agents";

/**
 * Ações do dashboard dos agentes. Toda verificação roda aqui, no servidor:
 * esconder um botão é conveniência, quem recusa é a action.
 *
 *   - configurar, mudar modo, ligar/desligar tudo, aprovar e fixar/banir
 *     nichos: owner e admin;
 *   - "executar agora" e cancelar tarefa: qualquer perfil de escrita (o clique
 *     de uma pessoa já é a aprovação da execução).
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });
const ok = (message?: string): ActionResult => ({ ok: true, message });

function refresh() {
  revalidatePath("/agentes", "layout");
}

export async function setGlobalSwitch(enabled: boolean): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  await setGloballyEnabled(Boolean(enabled));
  await logAgentEvent("sistema", "info", "global.switch", enabled ? `${admin.name} religou os agentes.` : `${admin.name} desligou todos os agentes.`);
  refresh();
  return ok(enabled ? "Agentes ligados." : "Todos os agentes foram desligados.");
}

export async function setAgentMode(agent: string, mode: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  if (!isAgentId(agent)) return fail("Agente desconhecido.");
  if (!(AGENT_MODES as readonly string[]).includes(mode)) return fail("Modo inválido.");
  await saveSettings(agent, { mode: mode as (typeof AGENT_MODES)[number] });
  await logAgentEvent(agent, "info", "agent.mode", `${admin.name} mudou o modo para ${mode}.`);
  refresh();
  return ok("Modo atualizado.");
}

const nicheConfigSchema = z.object({
  cities: z.array(citySchema).max(MAX_CITIES),
  niches: z.array(z.string().max(60)).max(40),
  sample_size: z.number().int().min(5).max(60),
  probe_sites: z.number().int().min(0).max(20),
  max_places_requests_day: z.number().int().min(0).max(500),
});

export async function saveNicheAnalystConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = nicheConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise cidades e limites.");
  const known = new Set(SUPPORTED_NICHES.map((n) => n.key));
  const config = normalizeNicheAnalystConfig({
    ...parsed.data,
    niches: parsed.data.niches.filter((n) => known.has(n)),
  });
  await saveSettings("niche-analyst", { config: { ...config } });
  refresh();
  return ok("Configuração salva.");
}

const prospectorConfigSchema = z.object({
  quantity_per_run: z.number().int().min(1).max(100),
  daily_leads_cap: z.number().int().min(0).max(500),
  max_places_requests_day: z.number().int().min(0).max(1000),
  min_niche_score: z.number().int().min(0).max(100),
  cooldown_days: z.number().int().min(0).max(90),
  filters: z.record(z.string(), z.boolean()),
});

export async function saveProspectorConfig(input: unknown): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const parsed = prospectorConfigSchema.safeParse(input);
  if (!parsed.success) return fail("Configuração inválida. Revise os limites.");
  const config = normalizeProspectorConfig({ ...parsed.data, filters: normalizeFilters(parsed.data.filters) });
  await saveSettings("prospector", { config: { ...config } });
  refresh();
  return ok("Configuração salva.");
}

/** Recusa executar para agente pausado ou com tudo desligado: a tarefa ficaria parada sem ninguém saber. */
async function assertCanRun(agent: AgentId): Promise<string | null> {
  if (!(await isGloballyEnabled())) return "Os agentes estão desligados. Ligue-os no interruptor geral.";
  if ((await getAgentMode(agent)) === "pausado") return "Este agente está pausado. Mude o modo para executar.";
  return null;
}

export async function runNicheAnalysisNow(): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const blocked = await assertCanRun("niche-analyst");
  if (blocked) return fail(blocked);
  if ((await getNicheAnalystConfig()).cities.length === 0) {
    return fail("Cadastre ao menos uma cidade antes de analisar.");
  }
  const { created } = await enqueueAgentTask({
    agent: "niche-analyst",
    kind: NICHE_ANALYZE,
    dedupeKey: `manual:${NICHE_ANALYZE}`,
    createdBy: user.id,
  });
  refresh();
  return ok(created ? "Análise na fila. Começa em instantes." : "Já existe uma análise na fila.");
}

const prospectNowSchema = z.object({
  niche: z.string().min(2).max(60),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(60).optional(),
  country: z.string().trim().min(2).max(60).default("Brasil"),
  quantity: z.number().int().min(1).max(100).optional(),
});

export async function prospectNow(input: unknown): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const parsed = prospectNowSchema.safeParse(input);
  if (!parsed.success) return fail("Informe nicho e cidade.");
  const niche = SUPPORTED_NICHES.find((n) => n.key === parsed.data.niche);
  if (!niche) return fail("Nicho não suportado pela fonte de empresas.");
  const blocked = await assertCanRun("prospector");
  if (blocked) return fail(blocked);

  const { created } = await enqueueAgentTask({
    agent: "prospector",
    kind: PROSPECT_RUN,
    payload: {
      niche: niche.key,
      niche_label: niche.label,
      city: parsed.data.city,
      state: parsed.data.state,
      country: parsed.data.country,
      quantity: parsed.data.quantity,
    },
    dedupeKey: `manual:${PROSPECT_RUN}:${niche.key}:${parsed.data.city.toLowerCase()}`,
    createdBy: user.id,
  });
  refresh();
  return ok(created ? "Prospecção na fila. Começa em instantes." : "Já existe uma prospecção igual na fila.");
}

export async function cancelTask(taskId: string): Promise<ActionResult> {
  const user = await getWriterUser();
  if (!user) return fail(WRITE_DENIED);
  const task = await cancelAgentTask(taskId);
  if (!task) return fail("A tarefa já terminou ou não existe.");
  await logAgentEvent(task.agent, "info", "task.cancelled", `${user.name} cancelou ${task.kind}.`, null, task.id);
  refresh();
  return ok("Tarefa cancelada.");
}

export async function decideAgentApproval(id: string, approve: boolean): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  const result = await decideApproval(id, Boolean(approve), admin.id);
  refresh();
  if (!result.ok) return fail(result.error);
  return ok(approve ? "Aprovado. A tarefa entrou na fila." : "Recusado.");
}

export async function setNicheTargetStatus(id: string, status: string): Promise<ActionResult> {
  const admin = await getAdminUser();
  if (!admin) return fail(ADMIN_DENIED);
  if (status !== "auto" && status !== "fixado" && status !== "banido") return fail("Estado inválido.");
  const updated = await agentRepo().update("niche_targets", id, { status });
  if (!updated) return fail("Nicho não encontrado.");
  refresh();
  return ok(status === "fixado" ? "Nicho fixado: será priorizado." : status === "banido" ? "Nicho banido: não será prospectado." : "Nicho voltou ao automático.");
}
