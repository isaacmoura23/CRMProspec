import "server-only";
import { AGENTS } from "@/agents/registry";
import { expireApprovals, submitPlannedTask } from "@/services/agents/approvals";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getAgentMode, isGloballyEnabled } from "@/services/agents/settings";

/**
 * Planejador: o que cada agente quer iniciar por conta própria.
 *
 * Roda a cada poucos minutos dentro do runner. Respeita o interruptor geral e
 * o modo de cada agente, e submete no máximo uma tarefa por agente por passada
 * — em aprovação, só uma proposta pendente por agente, para a fila de
 * aprovação não virar uma pilha.
 */

export interface PlanReport {
  enqueued: number;
  approvals: number;
}

export async function planAgents(): Promise<PlanReport> {
  const report: PlanReport = { enqueued: 0, approvals: 0 };
  if (!(await isGloballyEnabled())) return report;

  await expireApprovals();
  const repo = agentRepo();
  const pending = await repo.list("approvals", { where: { status: "pendente" } });

  for (const agent of AGENTS) {
    const mode = await getAgentMode(agent.id);
    if (mode === "pausado") continue;
    // Uma proposta esperando decisão já é o pedido deste agente.
    if (mode === "aprovacao" && pending.some((a) => a.agent === agent.id)) continue;

    try {
      for (const planned of await agent.plan()) {
        const outcome = await submitPlannedTask(planned, mode);
        if (outcome === "enqueued") report.enqueued += 1;
        if (outcome === "approval") report.approvals += 1;
        if (outcome !== "skipped") break;
      }
    } catch (err) {
      // Um agente que não consegue planejar não impede os outros.
      const message = err instanceof Error ? err.message : String(err);
      await logAgentEvent(agent.id, "error", "plan.failed", `Falha ao planejar: ${message}`);
    }
  }
  return report;
}
