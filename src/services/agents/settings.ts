import "server-only";
import {
  DEFAULT_AGENT_MODE,
  normalizeNicheAnalystConfig,
  normalizePresenceConfig,
  normalizeProspectorConfig,
  normalizeSellerConfig,
  normalizeSiteBuilderConfig,
  type NicheAnalystConfig,
  type PresenceConfig,
  type ProspectorConfig,
  type SellerConfig,
  type SiteBuilderConfig,
} from "@/agents/config";
import { agentRepo, orgId } from "@/services/agents/repository";
import { AGENT_IDS, GLOBAL_SETTINGS_ID, type AgentId, type AgentMode, type AgentSettingsRow } from "@/types/agents";

/**
 * Leitura e gravação das configurações dos agentes e do interruptor geral.
 *
 * Uma linha que nunca foi gravada não existe: a leitura devolve o padrão sem
 * persistir nada, então abrir a tela não cria estado.
 */

function defaultRow(id: string): AgentSettingsRow {
  return {
    id,
    organization_id: orgId(),
    // O interruptor geral nasce ligado; cada agente nasce em aprovação.
    mode: id === GLOBAL_SETTINGS_ID ? "automatico" : DEFAULT_AGENT_MODE,
    config: {},
    updated_at: new Date(0).toISOString(),
  };
}

export async function getSettingsRow(id: string): Promise<AgentSettingsRow> {
  return (await agentRepo().get("settings", id)) ?? defaultRow(id);
}

export async function saveSettings(
  id: string,
  patch: { mode?: AgentMode; config?: Record<string, unknown> }
): Promise<AgentSettingsRow> {
  const current = await getSettingsRow(id);
  const row: AgentSettingsRow = {
    ...current,
    mode: patch.mode ?? current.mode,
    config: patch.config ?? current.config,
    updated_at: new Date().toISOString(),
  };
  await agentRepo().upsert("settings", row);
  return row;
}

/** Interruptor geral: `pausado` interrompe todos os agentes. */
export async function isGloballyEnabled(): Promise<boolean> {
  return (await getSettingsRow(GLOBAL_SETTINGS_ID)).mode !== "pausado";
}

export async function setGloballyEnabled(enabled: boolean): Promise<void> {
  await saveSettings(GLOBAL_SETTINGS_ID, { mode: enabled ? "automatico" : "pausado" });
}

export async function getAgentMode(agent: AgentId): Promise<AgentMode> {
  return (await getSettingsRow(agent)).mode;
}

/**
 * Agentes cujas tarefas podem ser reivindicadas agora: interruptor geral
 * ligado e o próprio agente fora de `pausado`.
 */
export async function runnableAgents(): Promise<AgentId[]> {
  if (!(await isGloballyEnabled())) return [];
  const rows = await Promise.all(AGENT_IDS.map(async (id) => [id, await getAgentMode(id)] as const));
  return rows.filter(([, mode]) => mode !== "pausado").map(([id]) => id);
}

export async function getNicheAnalystConfig(): Promise<NicheAnalystConfig> {
  return normalizeNicheAnalystConfig((await getSettingsRow("niche-analyst")).config);
}

export async function getSellerConfig(): Promise<SellerConfig> {
  return normalizeSellerConfig((await getSettingsRow("seller")).config);
}

export async function getSiteBuilderConfig(): Promise<SiteBuilderConfig> {
  return normalizeSiteBuilderConfig((await getSettingsRow("site-builder")).config);
}

export async function getPresenceConfig(): Promise<PresenceConfig> {
  return normalizePresenceConfig((await getSettingsRow("presence")).config);
}

export async function getProspectorConfig(): Promise<ProspectorConfig> {
  return normalizeProspectorConfig((await getSettingsRow("prospector")).config);
}
