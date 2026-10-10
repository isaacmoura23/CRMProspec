import "server-only";
import { buildMeetingNotice } from "@/lib/conversation-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import { getSellerConfig } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { emitEvent } from "@/services/events";
import { setLeadStatus } from "@/services/lead-service";
import type { Lead } from "@/types";
import type { Meeting, OwnerNotice } from "@/types/agents";

/**
 * Reunião marcada pelo Vendedor: o registro, o que ela muda no CRM e o aviso
 * ao dono (sino sempre, WhatsApp pessoal quando há número configurado).
 */

/** Horários de reuniões ainda por vir: a base de "não propor horário ocupado". */
export async function upcomingMeetingTimes(now: Date): Promise<Date[]> {
  const rows = await agentRepo().list("meetings", { where: { status: "agendada" } });
  return rows.map((m) => new Date(m.at)).filter((d) => d.getTime() > now.getTime() - 3_600_000);
}

export async function createMeeting(input: { lead: Lead; at: Date; interestText: string | null; source?: Meeting["source"] }): Promise<Meeting> {
  const { lead, at } = input;
  const cfg = await getSellerConfig();
  const now = new Date().toISOString();
  const meeting: Meeting = {
    id: uid("mtg"),
    organization_id: orgId(),
    lead_id: lead.id,
    at: at.toISOString(),
    duration_min: cfg.meeting_duration_min,
    status: "agendada",
    source: input.source ?? "agente",
    interest_text: input.interestText,
    created_at: now,
    updated_at: now,
  };
  await agentRepo().insert("meetings", meeting);

  // No CRM: etapa, linha do tempo e uma tarefa no horário.
  setLeadStatus(lead.id, "reuniao", null);
  logActivity(lead.id, "reuniao", `Reunião marcada pelo Vendedor para ${at.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.`, null);
  const db = getDb();
  const assignee = lead.assigned_to ?? db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id ?? null;
  if (assignee) {
    db.tasks.push({
      id: uid("task"),
      organization_id: db.organization.id,
      lead_id: lead.id,
      assigned_to: assignee,
      type: "reuniao",
      title: `Reunião com ${lead.company_name}`,
      description: input.interestText ? `O lead disse: “${input.interestText.slice(0, 200)}”` : null,
      due_date: at.toISOString(),
      priority: "alta",
      completed: false,
      completed_at: null,
      created_at: now,
    });
    db.notifications.unshift({
      id: uid("ntf"),
      organization_id: db.organization.id,
      user_id: assignee,
      title: `Reunião marcada com ${lead.company_name}`,
      body: at.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }),
      link: "/agentes/vendedor",
      read: false,
      created_at: now,
    });
  }
  saveDb();
  emitEvent("meeting.scheduled", lead, { payload: { meeting_id: meeting.id, at: meeting.at, duration_min: meeting.duration_min } });
  await logAgentEvent("seller", "info", "meeting.scheduled", `Reunião marcada com ${lead.company_name} para ${meeting.at}.`, { lead_id: lead.id, meeting_id: meeting.id });

  await queueOwnerNotice(lead, meeting, cfg.owner_phone);
  return meeting;
}

/** Cria o aviso ao WhatsApp do dono. Sem número configurado, só o sino avisa (e o painel mostra isso). */
async function queueOwnerNotice(lead: Lead, meeting: Meeting, ownerPhone: string | null): Promise<OwnerNotice | null> {
  if (!ownerPhone) {
    await logAgentEvent("seller", "warn", "owner_notice.skipped", "Reunião marcada, mas não há WhatsApp do dono configurado: só o sino avisa.", { meeting_id: meeting.id });
    return null;
  }
  const cfg = await getSellerConfig();
  const now = new Date().toISOString();
  const notice: OwnerNotice = {
    id: uid("onot"),
    organization_id: orgId(),
    kind: "reuniao",
    lead_id: lead.id,
    meeting_id: meeting.id,
    phone: ownerPhone,
    body: buildMeetingNotice({
      companyName: lead.company_name,
      segment: lead.segment ?? null,
      city: lead.city ?? null,
      at: new Date(meeting.at),
      interest: meeting.interest_text,
      durationMin: cfg.meeting_duration_min,
    }),
    status: "pendente",
    attempts: 0,
    not_before: now,
    provider_message_id: null,
    last_error: null,
    idempotency_key: `owner-notice:${meeting.id}`,
    created_at: now,
    updated_at: now,
    sent_at: null,
  };
  try {
    await agentRepo().insert("owner_notices", notice);
    return notice;
  } catch (err) {
    if (err instanceof UniqueViolationError) return null;
    throw err;
  }
}
