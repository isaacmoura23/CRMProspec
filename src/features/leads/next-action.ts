import { daysUntil, formatDate } from "@/lib/format";
import type { Lead, LeadAnalysis, Task } from "@/types";

/** "Próxima melhor ação" sugerida para um lead */
export function buildNextAction(
  lead: Lead,
  tasks: Task[],
  analysis: LeadAnalysis | undefined
): string | null {
  const openTask = tasks
    .filter((t) => t.lead_id === lead.id && !t.completed)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  if (openTask) {
    const d = daysUntil(openTask.due_date);
    const when =
      d < 0 ? `vencida há ${-d}d` : d === 0 ? "hoje" : d === 1 ? "amanhã" : formatDate(openTask.due_date);
    return `${openTask.title.length > 32 ? openTask.title.slice(0, 32) + "…" : openTask.title} (${when})`;
  }
  if (!analysis) return "Analisar oportunidade";
  if (["analisado", "qualificado", "pronto_contato", "novo"].includes(lead.status))
    return "Enviar primeira abordagem";
  if (lead.status === "respondeu") return "Responder o lead";
  if (["contatado"].includes(lead.status)) return "Agendar follow-up";
  return null;
}
