import type { AgentId } from "@/types/agents";

/**
 * O que cada agente pode chamar — e o que NUNCA pode.
 *
 * Ferramentas com efeito fora do CRM (publicar no Instagram, criar, ativar ou
 * pausar campanha, mexer em orçamento) são **só humanas**: existem no código, mas
 * quem as chama é a Server Action do botão, depois do clique. Esta lista é a fonte
 * da regra, e um teste confere que (a) nenhum agente a recebe e (b) o código dos
 * agentes não importa nem cita as ferramentas humanas.
 */

/** Ferramentas de leitura e de proposta que os agentes podem usar. */
export const AGENT_TOOLS: Record<AgentId, readonly string[]> = {
  "niche-analyst": ["places.probe", "niche_targets.write"],
  prospector: ["places.search", "leads.create"],
  presence: ["http.fetch_public", "lead_dossiers.write"],
  seller: ["whatsapp.recipient", "outreach.propose_message", "conversation.propose_reply", "meetings.propose_slots"],
  "site-builder": ["lead_dossiers.read", "site_builds.write"],
  "traffic-manager": ["company_profile.read", "ads.read_report", "ads.propose_campaign", "ads.propose_budget_change"],
  "social-media": ["company_profile.read", "instagram.read_profile", "instagram.list_media", "social.propose_post"],
};

/** Ferramentas que só a ação do botão, depois do clique, pode chamar. */
export const HUMAN_ONLY_TOOLS = [
  "instagram.publish_media",
  "ads.create_campaign",
  "ads.activate_campaign",
  "ads.pause_campaign",
  "ads.set_budget",
] as const;

export type HumanOnlyTool = (typeof HUMAN_ONLY_TOOLS)[number];

/** O agente tem esta ferramenta na sua lista? */
export function agentHasTool(agent: AgentId, tool: string): boolean {
  return AGENT_TOOLS[agent].includes(tool);
}
