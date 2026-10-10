import "server-only";
import type { SellerConfig } from "@/agents/config";
import { isWithinWindow, nextWindowOpen } from "@/lib/outreach-policy";
import { getDb } from "@/lib/store";
import { dayKey } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig } from "@/services/agents/settings";
import { listBlocklist } from "@/services/outreach/blocklist";
import { outreachStats, windowOf } from "@/services/outreach/gate";
import type { AgentEvent, AgentMode, AgentTask, ChannelBlock, OutreachCycleStatus, OutreachMessageStatus } from "@/types/agents";

/** Dados da tela do Vendedor, já resolvidos no servidor e serializáveis. */

export interface QueueRow {
  id: string;
  lead_id: string;
  lead_name: string;
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
  status: OutreachMessageStatus;
  phone: string;
  body: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  error_detail: string | null;
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
  const [stats, cycles, messages, approvals, blocklist, tasks, events, lookups] = await Promise.all([
    outreachStats(now, config),
    repo.list("outreach_cycles", { orderBy: "created_at", desc: true, limit: 60 }),
    repo.list("outreach_messages", { orderBy: "created_at", desc: true, limit: 25 }),
    repo.list("approvals", { where: { kind: "outreach_message", status: "pendente" } }),
    listBlocklist(),
    repo.list("tasks", { where: { agent: "seller" }, orderBy: "created_at", desc: true, limit: 15 }),
    repo.list("events", { where: { agent: "seller" }, orderBy: "created_at", desc: true, limit: 25 }),
    repo.list("spend", { where: { agent: "seller", kind: "whatsapp_lookups", day: dayKey(now) } }),
  ]);

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
    pendingApprovals: approvals.length,
    counts,
    queue: cycles
      // O que acabou bem sai da fila (aparece em "Mensagens"); o resto precisa de olhar.
      .filter((c) => c.status !== "enviado")
      .slice(0, 30)
      .map((c) => ({
        id: c.id,
        lead_id: c.lead_id,
        lead_name: nameOf(c.lead_id),
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
