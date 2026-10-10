import "server-only";
import { nicheAnalyst, registerNicheAnalystHandlers } from "@/agents/niche/agent";
import { prospector, registerProspectorHandlers } from "@/agents/prospector/agent";
import type { AgentDefinition } from "@/agents/types";
import { isAgentId, type AgentId } from "@/types/agents";

/**
 * Registro dos agentes, no estilo de `providers/registry.ts`. Um agente novo
 * entra aqui (definição + handlers) e na lista de `AGENT_IDS`.
 */
export const AGENTS: AgentDefinition[] = [nicheAnalyst, prospector];

export function getAgent(id: string): AgentDefinition | undefined {
  return isAgentId(id) ? AGENTS.find((a) => a.id === id) : undefined;
}

export function agentName(id: AgentId): string {
  return AGENTS.find((a) => a.id === id)?.name ?? id;
}

type GlobalWithRegistered = typeof globalThis & { __agentsRegistered?: boolean };

/** Idempotente: liga cada tipo de tarefa ao seu handler. */
export function registerAgentHandlers() {
  const g = globalThis as GlobalWithRegistered;
  if (g.__agentsRegistered) return;
  registerNicheAnalystHandlers();
  registerProspectorHandlers();
  g.__agentsRegistered = true;
}
