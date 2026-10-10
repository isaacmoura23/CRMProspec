import "server-only";
import { uid } from "@/lib/utils";
import { agentRepo, orgId } from "@/services/agents/repository";
import type { AgentEvent, AgentEventLevel, AgentId, SpendKind } from "@/types/agents";

/**
 * Log estruturado e contabilidade de consumo dos agentes.
 *
 * Nada aqui pode derrubar um agente: registrar é secundário, então falhas
 * viram `console.error` e seguem.
 */

const DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Dia civil em São Paulo (YYYY-MM-DD): a base de todos os tetos diários. */
export function dayKey(date: Date = new Date()): string {
  return DAY_FMT.format(date);
}

export async function logAgentEvent(
  agent: AgentEvent["agent"],
  level: AgentEventLevel,
  type: string,
  message: string,
  data: Record<string, unknown> | null = null,
  taskId: string | null = null
): Promise<void> {
  try {
    await agentRepo().insert("events", {
      id: uid("aev"),
      organization_id: orgId(),
      agent,
      level,
      type,
      message,
      data,
      task_id: taskId,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[agentes] falha ao registrar evento:", err);
  }
}

export async function recordSpend(
  agent: AgentId,
  kind: SpendKind,
  amount: number,
  note: string | null = null
): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    const now = new Date();
    await agentRepo().insert("spend", {
      id: uid("spd"),
      organization_id: orgId(),
      agent,
      kind,
      amount,
      note,
      day: dayKey(now),
      created_at: now.toISOString(),
    });
  } catch (err) {
    console.error("[agentes] falha ao registrar consumo:", err);
  }
}

/** Quanto o agente já consumiu hoje de um recurso. */
export async function spentToday(agent: AgentId, kind: SpendKind): Promise<number> {
  const rows = await agentRepo().list("spend", { where: { agent, kind, day: dayKey() } });
  return rows.reduce((sum, r) => sum + r.amount, 0);
}
