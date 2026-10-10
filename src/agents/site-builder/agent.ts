import "server-only";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { dayKey } from "@/services/agents/log";
import { agentRepo, orgId } from "@/services/agents/repository";
import { SITE_BUILD, evaluateGate, newToken, registerSiteBuildHandlers } from "@/services/sites/build";
import type { SiteBuild } from "@/types/agents";

/**
 * Agente 5 — Programador de Sites.
 *
 * Constrói a prévia do site de um lead **só** depois de interesse explícito
 * registrado e de uma reunião marcada (a porta é código testado, em
 * `lib/site-gate.ts`). A entrada é apenas o dossiê do Agente 3: o site não
 * contém nada que o dossiê não comprove. A prévia sai num endereço não
 * adivinhável, fora dos buscadores, depois de verificada no navegador.
 *
 * Como só lê o dossiê e só escreve a própria prévia (nada é enviado a ninguém),
 * as tarefas entram na fila direto, em qualquer modo que não seja pausado.
 */

/** Uma construção por vez: abre o navegador e é pesada. */
const MAX_LIVE = 1;

async function plan(): Promise<PlannedTask[]> {
  const repo = agentRepo();
  const [builds, meetings] = await Promise.all([repo.list("site_builds"), repo.list("meetings", { where: { status: "agendada" } })]);
  if (builds.filter((b) => b.status === "na_fila" || b.status === "construindo" || b.status === "verificando").length >= MAX_LIVE) return [];

  const now = new Date();
  const out: PlannedTask[] = [];
  for (const m of meetings.sort((a, b) => a.at.localeCompare(b.at))) {
    if (Date.parse(m.at) <= now.getTime()) continue;
    const mine = builds.filter((b) => b.lead_id === m.lead_id && b.meeting_id === m.id);
    // Já tem prévia viva (ou construção em andamento) para esta reunião.
    if (mine.some((b) => b.status === "pronto" || b.status === "na_fila" || b.status === "construindo" || b.status === "verificando")) continue;
    // Falhou hoje: uma tentativa por dia (o que falhou por prazo ou dossiê pobre não melhora sozinho).
    if (mine.some((b) => b.status === "falhou" && b.updated_at.slice(0, 10) === now.toISOString().slice(0, 10))) continue;

    const { lead, gate } = await evaluateGate(m.lead_id, now);
    if (!lead) continue;
    if (!gate.ok) {
      // Sem tempo hábil: avisa uma vez, em vez de entregar pela metade.
      if (gate.code === "prazo" && mine.length === 0) await recordMissedDeadline(lead.id, lead.company_name, m.id, gate.reason, now);
      continue;
    }
    out.push({
      agent: "site-builder",
      kind: SITE_BUILD,
      payload: { lead_id: lead.id },
      dedupeKey: `${SITE_BUILD}:${m.id}:${dayKey()}`,
      title: `Construir a prévia do site de ${lead.company_name}`,
      detail: `Reunião em ${new Date(m.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
    });
    if (out.length >= MAX_LIVE) break;
  }
  return out;
}

/** Registra que a prévia não cabe no prazo e avisa no sino — uma vez só por reunião. */
async function recordMissedDeadline(leadId: string, name: string, meetingId: string, reason: string, now: Date): Promise<void> {
  const iso = now.toISOString();
  const build: SiteBuild = {
    id: uid("sbd"),
    organization_id: orgId(),
    lead_id: leadId,
    meeting_id: meetingId,
    status: "falhou",
    builder: "modelos",
    token: newToken(),
    content_hash: null,
    checks: [],
    screenshots: [],
    error: reason,
    deadline_at: null,
    cost_usd: 0,
    created_at: iso,
    updated_at: iso,
    ready_at: null,
    expires_at: null,
  };
  await agentRepo().insert("site_builds", build);
  const db = getDb();
  const userId = db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (userId) {
    db.notifications.unshift({ id: uid("ntf"), organization_id: db.organization.id, user_id: userId, title: `Sem tempo para a prévia de ${name}`, body: "A reunião está perto demais para uma prévia verificada. Nada foi entregue pela metade.", link: "/agentes/site-builder", read: false, created_at: iso });
    saveDb();
  }
}

export const siteBuilder: AgentDefinition = {
  id: "site-builder",
  name: "Programador de Sites",
  description: "Depois que o lead demonstra interesse e marca reunião, monta a prévia do site só com o que o dossiê comprova, verifica no navegador e a deixa pronta antes da reunião.",
  kinds: [SITE_BUILD],
  direct: true,
  plan,
};

export function registerSiteBuilderHandlers() {
  registerSiteBuildHandlers();
}
