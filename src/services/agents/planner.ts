import "server-only";
import { AGENTS } from "@/agents/registry";
import { expireApprovals, submitPlannedTask } from "@/services/agents/approvals";
import { enqueueAgentTask } from "@/services/agents/queue";
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

    // Agente que só prepara: entra na fila direto; a aprovação é da mensagem, não da tarefa.
    if (agent.direct) {
      try {
        for (const planned of await agent.plan()) {
          // Qualquer tarefa com a mesma chave (viva, concluída ou falha) já cobre o dia.
          if ((await repo.list("tasks", { where: { dedupe_key: planned.dedupeKey }, limit: 1 })).length > 0) continue;
          const { created } = await enqueueAgentTask({ agent: planned.agent, kind: planned.kind, payload: planned.payload, dedupeKey: planned.dedupeKey });
          if (created) report.enqueued += 1;
        }
      } catch (err) {
        await logAgentEvent(agent.id, "error", "plan.failed", `Falha ao planejar: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

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
