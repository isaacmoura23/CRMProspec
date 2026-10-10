import "server-only";
import type { SiteBuilderConfig } from "@/agents/config";
import { getDb } from "@/lib/store";
import { agentRepo } from "@/services/agents/repository";
import { getSiteBuilderConfig } from "@/services/agents/settings";
import { findBrowser } from "@/services/presence/visual";
import { evaluateGate } from "@/services/sites/build";
import type { SiteBuild } from "@/types/agents";

/** Dados da tela do Agente 5, já resolvidos no servidor e serializáveis. */

export interface BuildRow {
  build: Omit<SiteBuild, "token">;
  lead_name: string;
  meeting_at: string | null;
  /** Caminho da prévia (só existe enquanto ela está no ar). */
  preview_path: string | null;
}

export interface SiteBuilderPanelData {
  config: SiteBuilderConfig;
  rows: BuildRow[];
  browserFound: boolean;
  /** Leads com reunião marcada e a porta ainda fechada, com o motivo. */
  waiting: Array<{ lead_id: string; lead_name: string; meeting_at: string; reason: string }>;
}

export async function getSiteBuilderPanel(): Promise<SiteBuilderPanelData> {
  const repo = agentRepo();
  const [config, builds, meetings] = await Promise.all([
    getSiteBuilderConfig(),
    repo.list("site_builds", { orderBy: "created_at", desc: true, limit: 30 }),
    repo.list("meetings", { where: { status: "agendada" }, orderBy: "at" }),
  ]);
  const leads = new Map(getDb().leads.map((l) => [l.id, l.company_name]));
  const meetingAt = new Map((await repo.list("meetings")).map((m) => [m.id, m.at]));
  const now = new Date();

  const rows: BuildRow[] = builds.map((b) => {
    // O token (o "segredo" do endereço) só vai ao navegador de quem já está logado, dentro do caminho da prévia.
    const { token, ...rest } = b;
    return {
      build: rest,
      lead_name: leads.get(b.lead_id) ?? "Lead removido",
      meeting_at: b.meeting_id ? (meetingAt.get(b.meeting_id) ?? null) : null,
      preview_path: b.status === "pronto" && b.expires_at && b.expires_at > now.toISOString() ? `/previa/${token}` : null,
    };
  });

  const waiting: SiteBuilderPanelData["waiting"] = [];
  for (const m of meetings) {
    if (Date.parse(m.at) <= now.getTime()) continue;
    if (builds.some((b) => b.meeting_id === m.id && (b.status === "pronto" || b.status === "na_fila" || b.status === "construindo" || b.status === "verificando"))) continue;
    const { gate } = await evaluateGate(m.lead_id, now);
    if (!gate.ok) waiting.push({ lead_id: m.lead_id, lead_name: leads.get(m.lead_id) ?? "Lead removido", meeting_at: m.at, reason: gate.reason });
  }
  return { config, rows, browserFound: Boolean(findBrowser()), waiting };
}
