import "server-only";
import { samePhone } from "@/lib/conversation-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { cancelAgentTask } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import type { Conversation, Lead, Message } from "@/types";
import type { ConversationState } from "@/types/agents";

/**
 * Estado da conversa por lead e o que se faz ao passá-la para uma pessoa.
 *
 * O CRM já tem conversas e mensagens (`db.conversations`, `db.messages`, a tela
 * /conversas). O WhatsApp escreve nelas, em vez de criar um segundo histórico.
 * O que é só do agente (quem conduz, que horários propôs, o que falta) mora em
 * `conversation_state`, um registro por lead.
 */

const blankState = (leadId: string, now: string): ConversationState => ({
  id: leadId,
  organization_id: orgId(),
  lead_id: leadId,
  control: "agente",
  control_reason: null,
  awaiting: "nada",
  proposed_slots: [],
  last_inbound_at: null,
  last_classification: null,
  attention_reason: null,
  interest_text: null,
  interest_at: null,
  created_at: now,
  updated_at: now,
});

export async function getConversationState(leadId: string): Promise<ConversationState | null> {
  return agentRepo().get("conversation_state", leadId);
}

/** Cria o registro se não existir e aplica a alteração. */
export async function patchConversationState(leadId: string, patch: Partial<ConversationState>): Promise<ConversationState> {
  const repo = agentRepo();
  const now = new Date().toISOString();
  const current = await repo.get("conversation_state", leadId);
  if (!current) {
    const fresh = { ...blankState(leadId, now), ...patch, id: leadId, lead_id: leadId, updated_at: now };
    await repo.insert("conversation_state", fresh);
    return fresh;
  }
  return (await repo.update("conversation_state", leadId, { ...patch, updated_at: now })) ?? current;
}

/** Leads cuja conversa você assumiu: o agente não escreve neles. */
export async function humanLeadIds(): Promise<Set<string>> {
  const rows = await agentRepo().list("conversation_state", { where: { control: "humano" } });
  return new Set(rows.map((r) => r.lead_id));
}

export async function isHumanControlled(leadId: string): Promise<boolean> {
  return (await getConversationState(leadId))?.control === "humano";
}

/* ------------------------------------------------------------------ */
/* Lead pelo telefone                                                  */
/* ------------------------------------------------------------------ */

/**
 * Lead dono de um telefone, tolerando o nono dígito. Com mais de um (cadastro
 * duplicado), vale o que o Vendedor contatou por último.
 */
export async function findLeadByPhone(phone: string): Promise<Lead | null> {
  await ensureLeadsLoaded();
  const matches = getDb().leads.filter((l) => !l.archived && (samePhone(l.whatsapp, phone) || samePhone(l.phone, phone)));
  if (matches.length <= 1) return matches[0] ?? null;
  const sent = await agentRepo().list("outreach_messages", { orderBy: "created_at", desc: true, limit: 500 });
  for (const m of sent) {
    const hit = matches.find((l) => l.id === m.lead_id);
    if (hit) return hit;
  }
  return matches[0] ?? null;
}

/** O Vendedor já mandou (ou pode ter mandado) alguma mensagem a este lead? */
export async function wasContactedByAgent(leadId: string): Promise<boolean> {
  const sent = await agentRepo().list("outreach_messages", { where: { lead_id: leadId } });
  return sent.some((m) => m.status === "SENT" || m.status === "DELIVERED" || m.status === "READ" || m.status === "UNCERTAIN");
}

/* ------------------------------------------------------------------ */
/* Histórico (as conversas do CRM)                                     */
/* ------------------------------------------------------------------ */

export interface RecordedMessage {
  message: Message;
  conversation: Conversation;
  /** A mesma mensagem do WhatsApp já estava gravada. */
  duplicate: boolean;
}

export function recordConversationMessage(input: {
  leadId: string;
  direction: "in" | "out";
  text: string;
  author: "lead" | "agente" | "humano";
  providerMessageId?: string | null;
  classification?: string | null;
  at?: string;
}): RecordedMessage {
  const db = getDb();
  const now = input.at ?? new Date().toISOString();
  let conversation = db.conversations.find((c) => c.lead_id === input.leadId && c.channel === "whatsapp");
  if (!conversation) {
    conversation = { id: uid("conv"), organization_id: db.organization.id, lead_id: input.leadId, channel: "whatsapp", last_message_at: now, unread: false };
    db.conversations.push(conversation);
  }
  if (input.providerMessageId) {
    const existing = db.messages.find((m) => m.provider_message_id === input.providerMessageId);
    if (existing) return { message: existing, conversation, duplicate: true };
  }
  const message: Message = {
    id: uid("msg"),
    conversation_id: conversation.id,
    direction: input.direction,
    content: input.text,
    classification: input.classification ?? null,
    created_at: now,
    ...(input.providerMessageId ? { provider_message_id: input.providerMessageId } : {}),
    author: input.author,
  };
  db.messages.push(message);
  conversation.last_message_at = now;
  if (input.direction === "in") conversation.unread = true;
  saveDb();
  return { message, conversation, duplicate: false };
}

/** O que o lead escreveu desde a última mensagem enviada a ele (uma rajada vira um texto só). */
export function inboundSinceLastOut(leadId: string): { text: string; lastMessageId: string | null } {
  const db = getDb();
  const conv = db.conversations.find((c) => c.lead_id === leadId && c.channel === "whatsapp");
  if (!conv) return { text: "", lastMessageId: null };
  const thread = db.messages.filter((m) => m.conversation_id === conv.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const burst: Message[] = [];
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i]!.direction === "out") break;
    burst.unshift(thread[i]!);
  }
  return { text: burst.map((m) => m.content).join("\n").slice(0, 1500), lastMessageId: burst[burst.length - 1]?.id ?? null };
}

/* ------------------------------------------------------------------ */
/* Passar a conversa a uma pessoa                                      */
/* ------------------------------------------------------------------ */

/**
 * Cancela tudo o que o agente tinha a caminho para este lead: ciclos ainda não
 * reivindicados, pedidos de aprovação pendentes e preparos na fila. Usado quando
 * o lead pede para parar e quando você assume a conversa.
 */
export async function cancelPendingForLead(leadId: string, reason: string): Promise<{ cycles: number; approvals: number; tasks: number }> {
  const repo = agentRepo();
  const now = new Date().toISOString();
  let cycles = 0;
  let approvals = 0;
  let tasks = 0;

  for (const c of await repo.list("outreach_cycles", { where: { lead_id: leadId, status: "agendado" } })) {
    await repo.update("outreach_cycles", c.id, { status: "cancelado", skip_reason: reason, updated_at: now, claimed_at: null });
    cycles += 1;
  }
  for (const a of await repo.list("approvals", { where: { status: "pendente" } })) {
    if (a.kind === "agent_task") continue;
    if ((a.payload as { lead_id?: string }).lead_id !== leadId) continue;
    await repo.update("approvals", a.id, { status: "expirado", decided_at: now });
    approvals += 1;
  }
  for (const t of await repo.list("tasks", { where: { agent: "seller" } })) {
    if ((t.status !== "pendente" && t.status !== "processando") || (t.payload as { lead_id?: string }).lead_id !== leadId) continue;
    // A tarefa de responder confere o controle da conversa antes de escrever: não precisa ser cancelada.
    if (t.kind === "conversation.respond") continue;
    // Uma resposta já em processamento termina sozinha: ela própria confere o controle antes de escrever.
    if (t.status === "pendente" && (await cancelAgentTask(t.id))) tasks += 1;
  }
  return { cycles, approvals, tasks };
}

/** Passa a conversa a uma pessoa e avisa no sino. */
export async function handOffToHuman(lead: Lead, reason: string, opts: { notify?: boolean } = {}): Promise<void> {
  await patchConversationState(lead.id, { awaiting: "humano", attention_reason: reason, proposed_slots: [] });
  await logAgentEvent("seller", "warn", "conversation.handoff", `${lead.company_name} precisa de você: ${reason}`, { lead_id: lead.id });
  if (opts.notify === false) return;
  const db = getDb();
  const userId = lead.assigned_to ?? db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (!userId) return;
  db.notifications.unshift({
    id: uid("ntf"),
    organization_id: db.organization.id,
    user_id: userId,
    title: `${lead.company_name} precisa de você`,
    body: reason.slice(0, 140),
    link: "/agentes/vendedor",
    read: false,
    created_at: new Date().toISOString(),
  });
  saveDb();
}
