import type { AgentMode, AgentTaskStatus } from "@/types/agents";

/** Rótulos e variantes visuais compartilhados pelas telas dos agentes. */

export const MODE_LABEL: Record<AgentMode, string> = {
  pausado: "Pausado",
  aprovacao: "Em aprovação",
  automatico: "Automático",
};

export const MODE_HINT: Record<AgentMode, string> = {
  pausado: "Não inicia nem executa nada. Tarefas já na fila esperam.",
  aprovacao: "O que o agente decide iniciar vira um pedido e só roda depois do seu clique.",
  automatico: "Inicia e executa sozinho, dentro dos tetos diários.",
};

export const MODE_BADGE: Record<AgentMode, "neutral" | "warning" | "default"> = {
  pausado: "neutral",
  aprovacao: "warning",
  automatico: "default",
};

export const TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  pendente: "Na fila",
  processando: "Rodando",
  concluido: "Concluída",
  falhou: "Falhou",
  cancelado: "Cancelada",
};

export const TASK_STATUS_BADGE: Record<AgentTaskStatus, "neutral" | "info" | "good" | "danger" | "outline"> = {
  pendente: "neutral",
  processando: "info",
  concluido: "good",
  falhou: "danger",
  cancelado: "outline",
};

export const KIND_LABEL: Record<string, string> = {
  "niche.analyze": "Analisar nichos",
  "prospect.run": "Prospectar",
  "outreach.prepare": "Preparar abordagem",
  "conversation.respond": "Responder lead",
  "dossier.build": "Montar dossiê",
  "site.build": "Construir prévia do site",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}
