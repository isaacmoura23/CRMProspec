import "server-only";
import type { SellerConfig } from "@/agents/config";
import { isWithinWindow, nextWindowOpen } from "@/lib/outreach-policy";
import { getDb } from "@/lib/store";
import { dayKey } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig } from "@/services/agents/settings";
import { listBlocklist } from "@/services/outreach/blocklist";
import { outreachStats, windowOf } from "@/services/outreach/gate";
import type {
  AgentEvent,
  AgentMode,
  AgentTask,
  ChannelBlock,
  ConversationAwaiting,
  ConversationControl,
  MeetingStatus,
  OutreachCycleKind,
  OutreachCycleStatus,
  OutreachMessageStatus,
  OwnerNoticeStatus,
} from "@/types/agents";

/** Dados da tela do Vendedor, já resolvidos no servidor e serializáveis. */

export interface QueueRow {
  id: string;
  lead_id: string;
  lead_name: string;
  kind: OutreachCycleKind;
  touch: number;
  status: OutreachCycleStatus;
  phone: string;
  scheduled_for: string;
  not_before: string;
  attempts: number;
  /** Por que está esperando (ou o que deu errado). */
  note: string | null;
  sent_at: string | null;
}

export interface MessageRow {
  id: string;
  lead_id: string;
  lead_name: string;
  /** Resposta a algo que o lead escreveu (e não um toque de abordagem). */
  is_reply: boolean;
  status: OutreachMessageStatus;
  phone: string;
  body: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  error_detail: string | null;
}

export interface ConversationRow {
  lead_id: string;
  lead_name: string;
  lead_status: string;
  control: ConversationControl;
  control_reason: string | null;
  awaiting: ConversationAwaiting;
  attention_reason: string | null;
  last_classification: string | null;
  last_inbound_at: string | null;
  /** Última mensagem da conversa (do lead, do agente ou sua), cortada. */
  last_text: string | null;
  last_direction: "in" | "out" | null;
  unread: boolean;
}

export interface MeetingRow {
  id: string;
  lead_id: string;
  lead_name: string;
  at: string;
  duration_min: number;
  status: MeetingStatus;
  interest_text: string | null;
  notice: { status: OwnerNoticeStatus; error: string | null } | null;
}

export interface SellerPanelData {
  mode: AgentMode;
  config: SellerConfig;
  stats: {
    sentToday: number;
    cap: number;
    warmingUp: boolean;
    nextAllowedAt: string | null;
    windowOpen: boolean;
    nextWindowOpen: string | null;
    lookupsToday: number;
  };
  pendingApprovals: number;
  /** Conversas que esperam uma pessoa (o agente passou a mão). */
  attention: ConversationRow[];
  /** Conversas recentes do WhatsApp, com quem conduz cada uma. */
  conversations: ConversationRow[];
  meetings: MeetingRow[];
  ownerPhoneSet: boolean;
  counts: Partial<Record<OutreachCycleStatus, number>>;
  queue: QueueRow[];
  messages: MessageRow[];
  blocklist: ChannelBlock[];
  tasks: AgentTask[];
  events: AgentEvent[];
}

export async function getSellerPanel(now: Date = new Date()): Promise<SellerPanelData> {
  const repo = agentRepo();
  const [mode, config] = await Promise.all([getAgentMode("seller"), getSellerConfig()]);
  const [stats, cycles, messages, approvals, blocklist, tasks, events, lookups, states, meetings, notices] = await Promise.all([
    outreachStats(now, config),
    repo.list("outreach_cycles", { orderBy: "created_at", desc: true, limit: 200 }),
    repo.list("outreach_messages", { orderBy: "created_at", desc: true, limit: 25 }),
    repo.list("approvals", { where: { status: "pendente" } }),
    listBlocklist(),
    repo.list("tasks", { where: { agent: "seller" }, orderBy: "created_at", desc: true, limit: 15 }),
    repo.list("events", { where: { agent: "seller" }, orderBy: "created_at", desc: true, limit: 25 }),
    repo.list("spend", { where: { agent: "seller", kind: "whatsapp_lookups", day: dayKey(now) } }),
    repo.list("conversation_state", { orderBy: "updated_at", desc: true, limit: 60 }),
    repo.list("meetings", { orderBy: "at", limit: 40 }),
    repo.list("owner_notices", { orderBy: "created_at", desc: true, limit: 60 }),
  ]);

  const db = getDb();
  const cycleKind = new Map(cycles.map((c) => [c.id, c.kind]));
  const conversationRow = (s: (typeof states)[number]): ConversationRow => {
    const lead = db.leads.find((l) => l.id === s.lead_id);
    const conv = db.conversations.find((c) => c.lead_id === s.lead_id && c.channel === "whatsapp");
    const last = conv ? db.messages.filter((m) => m.conversation_id === conv.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;
    return {
      lead_id: s.lead_id,
      lead_name: lead?.company_name ?? "Lead removido",
      lead_status: lead?.status ?? "—",
      control: s.control,
      control_reason: s.control_reason,
      awaiting: s.awaiting,
      attention_reason: s.attention_reason,
      last_classification: s.last_classification,
      last_inbound_at: s.last_inbound_at,
      last_text: last ? last.content.slice(0, 160) : null,
      last_direction: last ? last.direction : null,
      unread: Boolean(conv?.unread),
    };
  };
  const conversationRows = states.map(conversationRow);

  const leads = new Map(getDb().leads.map((l) => [l.id, l.company_name]));
  const nameOf = (id: string) => leads.get(id) ?? "Lead removido";
  const window = windowOf(config);

  const counts: Partial<Record<OutreachCycleStatus, number>> = {};
  for (const c of cycles) counts[c.status] = (counts[c.status] ?? 0) + 1;

  return {
    mode,
    config,
    stats: {
      sentToday: stats.sentToday,
      cap: stats.cap,
      warmingUp: config.warmup && stats.cap < config.daily_cap_max,
      nextAllowedAt: stats.nextAllowedAt && stats.nextAllowedAt > now ? stats.nextAllowedAt.toISOString() : null,
      windowOpen: isWithinWindow(now, window),
      nextWindowOpen: nextWindowOpen(now, window)?.toISOString() ?? null,
      lookupsToday: lookups.reduce((n, s) => n + s.amount, 0),
    },
    pendingApprovals: approvals.filter((a) => a.kind === "outreach_message" || a.kind === "conversation_reply").length,
    attention: conversationRows.filter((c) => c.awaiting === "humano"),
    conversations: conversationRows.filter((c) => c.last_text !== null || c.control === "humano").slice(0, 20),
    meetings: meetings.map((m) => {
      const notice = notices.find((n) => n.meeting_id === m.id);
      return {
        id: m.id,
        lead_id: m.lead_id,
        lead_name: nameOf(m.lead_id),
        at: m.at,
        duration_min: m.duration_min,
        status: m.status,
        interest_text: m.interest_text,
        notice: notice ? { status: notice.status, error: notice.last_error } : null,
      };
    }),
    ownerPhoneSet: Boolean(config.owner_phone),
    counts,
    queue: cycles
      // O que acabou bem sai da fila (aparece em "Mensagens"); o resto precisa de olhar.
      .filter((c) => c.status !== "enviado")
      .slice(0, 30)
      .map((c) => ({
        id: c.id,
        lead_id: c.lead_id,
        lead_name: nameOf(c.lead_id),
        kind: c.kind,
        touch: c.touch,
        status: c.status,
        phone: c.phone,
        scheduled_for: c.scheduled_for,
        not_before: c.not_before,
        attempts: c.attempts,
        note: c.skip_reason ?? c.last_error,
        sent_at: c.sent_at,
      })),
    messages: messages.map((m) => ({
      id: m.id,
      lead_id: m.lead_id,
      lead_name: nameOf(m.lead_id),
      is_reply: cycleKind.get(m.cycle_id) === "resposta",
      status: m.status,
      phone: m.phone,
      body: m.body,
      sent_at: m.sent_at,
      delivered_at: m.delivered_at,
      read_at: m.read_at,
      error_detail: m.error_detail,
    })),
    blocklist,
    tasks,
    events,
  };
}
