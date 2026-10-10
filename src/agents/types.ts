import type { AgentId } from "@/types/agents";

/** Uma tarefa que o agente decidiu iniciar por conta própria. */
export interface PlannedTask {
  agent: AgentId;
  kind: string;
  payload: Record<string, unknown>;
  /**
   * Identifica "o mesmo trabalho" no mesmo dia. Impede o planejador de propor
   * de novo o que já foi proposto, recusado, executado ou falhou hoje.
   */
  dedupeKey: string;
  title: string;
  detail: string;
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  /** Uma linha: o que o agente faz. */
  description: string;
  /** Tipos de tarefa que ele executa. */
  kinds: string[];
  /**
   * O que ele quer fazer agora, em ordem de prioridade, olhando o estado
   * atual. Não grava nada. O planejador submete no máximo uma por passada.
   */
  plan(): Promise<PlannedTask[]>;
}
