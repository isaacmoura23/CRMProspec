import "server-only";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import { dayKey, spentToday } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getPresenceConfig } from "@/services/agents/settings";
import { DOSSIER_BUILD, dossierCandidates, registerDossierHandlers } from "@/services/presence/build";

/**
 * Agente 3 — Analista de Presença Digital.
 *
 * Monta o dossiê de cada lead antes de o Vendedor abordá-lo: site atual (com
 * nota por rubrica), ficha do Google Maps, Instagram, Facebook, link na bio,
 * YouTube, Mercado Livre e OLX — só conteúdo público, cada fonte com seu estado
 * (concluída, parcial, bloqueada, pendente) e cada afirmação com a evidência.
 *
 * Só lê e só escreve o dossiê; por isso as tarefas entram na fila direto, em
 * qualquer modo que não seja pausado, sem pedir aprovação a cada lead.
 */

/** Dossiês em montagem ao mesmo tempo: cada um faz várias requisições a sites de terceiros. */
const MAX_LIVE = 2;

async function plan(): Promise<PlannedTask[]> {
  const cfg = await getPresenceConfig();
  const room = cfg.dossiers_per_day - (await spentToday("presence", "dossiers"));
  if (room <= 0) return [];

  const live = (await agentRepo().list("tasks", { where: { agent: "presence", kind: DOSSIER_BUILD } })).filter((t) => t.status === "pendente" || t.status === "processando").length;
  const slots = Math.min(room, MAX_LIVE - live);
  if (slots <= 0) return [];

  const leads = await dossierCandidates(cfg, slots);
  return leads.map((lead) => ({
    agent: "presence" as const,
    kind: DOSSIER_BUILD,
    payload: { lead_id: lead.id },
    // Uma tentativa por lead por dia: um dossiê que falhou não é refeito a cada minuto.
    dedupeKey: `${DOSSIER_BUILD}:${lead.id}:${dayKey()}`,
    title: `Montar o dossiê de ${lead.company_name}`,
    detail: `${lead.segment} · ${lead.city} · score ${lead.lead_score ?? "—"}`,
  }));
}

export const presence: AgentDefinition = {
  id: "presence",
  name: "Analista de Presença Digital",
  description: "Monta o dossiê de cada lead com o que é público (site, Google Maps, redes), nota o site por rubrica e guarda a evidência de cada afirmação.",
  kinds: [DOSSIER_BUILD],
  direct: true,
  plan,
};

export function registerPresenceHandlers() {
  registerDossierHandlers();
}
