import "server-only";
import type { PresenceConfig } from "@/agents/config";
import { getDb } from "@/lib/store";
import { spentToday } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getPresenceConfig } from "@/services/agents/settings";
import { dossierCandidates } from "@/services/presence/build";
import { isVisualAvailable } from "@/services/presence/visual";
import type { LeadDossier } from "@/types/agents";

/** Dados da tela do Agente 3, já resolvidos no servidor e serializáveis. */

export interface DossierRow {
  dossier: LeadDossier;
  lead_name: string;
  segment: string;
  city: string;
}

export interface PresencePanelData {
  config: PresenceConfig;
  rows: DossierRow[];
  waiting: number;
  doneToday: number;
  visual: { available: boolean; reason: string | null };
}

export async function getPresencePanel(): Promise<PresencePanelData> {
  const config = await getPresenceConfig();
  const [dossiers, doneToday, candidates] = await Promise.all([
    agentRepo().list("lead_dossiers", { orderBy: "updated_at", desc: true, limit: 40 }),
    spentToday("presence", "dossiers"),
    dossierCandidates(config, 500),
  ]);
  const leads = new Map(getDb().leads.map((l) => [l.id, l]));
  const v = isVisualAvailable();
  return {
    config,
    rows: dossiers.map((d) => ({ dossier: d, lead_name: leads.get(d.lead_id)?.company_name ?? "Lead removido", segment: leads.get(d.lead_id)?.segment ?? "", city: leads.get(d.lead_id)?.city ?? "" })),
    waiting: candidates.length,
    doneToday,
    visual: { available: v.ok, reason: v.reason },
  };
}
