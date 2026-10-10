import "server-only";
import { detectOptOut } from "@/lib/conversation-policy";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { enqueueAgentTask } from "@/services/agents/queue";
import { agentRepo } from "@/services/agents/repository";
import { logActivity } from "@/services/activity";
import { emitEvent } from "@/services/events";
import { setLeadStatus } from "@/services/lead-service";
import { blockPhone } from "@/services/outreach/blocklist";
import { cancelPendingForLead, findLeadByPhone, getConversationState, patchConversationState, recordConversationMessage } from "@/services/conversation/state";
import type { Lead } from "@/types";

/**
 * Entrada das mensagens do WhatsApp no CRM.
 *
 * Duas fontes, com efeitos opostos:
 *   - `message.received`: o lead escreveu → grava, trata pedido de parada AQUI
 *     (regra fixa, antes de qualquer modelo) e, se a conversa é do agente,
 *     enfileira a resposta;
 *   - `message.from_phone`: VOCÊ escreveu pelo celular → grava como humana e tira
 *     a conversa das mãos do agente, sem precisar apertar nenhum botão.
 *
 * Nada aqui envia mensagem. Responder é a tarefa `conversation.respond`.
 */

export const CONVERSATION_RESPOND = "conversation.respond";

export interface IncomingMessage {
  providerMessageId: string;
  /** Telefone do contato em E.164. */
  peer: string;
  text: string;
  mediaType: string | null;
  profileName: string | null;
  /** Quando a mensagem foi escrita (a do evento é a da entrega). */
  at: string | null;
}

export type InboundOutcome =
  | { result: "no_lead" }
  | { result: "duplicate" }
  | { result: "opt_out"; leadId: string }
  | { result: "human_controlled"; leadId: string }
  | { result: "queued"; leadId: string }
  | { result: "own_message" }
  | { result: "taken_over"; leadId: string };

const EARLY_STATUSES: Lead["status"][] = ["novo", "analisado", "qualificado", "pronto_contato", "contatado"];

/** Texto a guardar: mídia sem legenda vira um marcador legível, nunca vazio. */
export function displayText(m: Pick<IncomingMessage, "text" | "mediaType">): string {
  const t = m.text.trim();
  if (t) return t;
  return m.mediaType ? `[${m.mediaType}]` : "[mensagem sem texto]";
}

/** O texto é só um marcador de mídia ("[audio]")? Então não há o que classificar. */
export function isMediaPlaceholder(text: string): boolean {
  return /^\[[^\]]{1,40}\]$/.test(text.trim());
}

function notifyReply(lead: Lead, text: string) {
  const db = getDb();
  const userId = lead.assigned_to ?? db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (!userId) return;
  db.notifications.unshift({
    id: uid("ntf"),
    organization_id: db.organization.id,
    user_id: userId,
    title: `${lead.company_name} respondeu`,
    body: text.slice(0, 100),
    link: "/conversas",
    read: false,
    created_at: new Date().toISOString(),
  });
}

export async function handleInboundMessage(msg: IncomingMessage): Promise<InboundOutcome> {
  const lead = await findLeadByPhone(msg.peer);
  if (!lead) {
    // Sem lead não há por que guardar o texto: só o fato, sem o conteúdo nem o número.
    await logAgentEvent("seller", "info", "conversation.unknown", "Mensagem de um número que não é de nenhum lead foi ignorada.");
    return { result: "no_lead" };
  }

  const text = displayText(msg);
  const recorded = recordConversationMessage({
    leadId: lead.id,
    direction: "in",
    text,
    author: "lead",
    providerMessageId: msg.providerMessageId,
    at: msg.at ?? undefined,
  });
  if (recorded.duplicate) return { result: "duplicate" };

  if (EARLY_STATUSES.includes(lead.status)) setLeadStatus(lead.id, "respondeu", null);
  lead.updated_at = new Date().toISOString();
  logActivity(lead.id, "resposta_recebida", `Lead respondeu pelo WhatsApp: "${text.slice(0, 80)}"`, null);
  notifyReply(lead, text);
  saveDb();
  await patchConversationState(lead.id, { last_inbound_at: recorded.message.created_at });
  emitEvent("lead.replied", lead, { payload: { message: text, conversation_id: recorded.conversation.id, channel: "whatsapp" } });
  saveDb();

  // Pedido de parada: regra fixa, antes de qualquer modelo e antes de qualquer outra coisa.
  if (detectOptOut(text)) {
    await blockPhone(msg.peer, "pediu para parar", "opt_out");
    const cancelled = await cancelPendingForLead(lead.id, "o lead pediu para parar");
    setLeadStatus(lead.id, "perdido", null);
    logActivity(lead.id, "perda", "Pediu para não receber mais mensagens: número bloqueado e abordagens canceladas.", null);
    saveDb();
    await patchConversationState(lead.id, { awaiting: "nada", attention_reason: null, proposed_slots: [], last_classification: "pede_parada" });
    await logAgentEvent("seller", "info", "conversation.opt_out", `${lead.company_name} pediu para parar: número bloqueado, ${cancelled.cycles + cancelled.approvals + cancelled.tasks} item(ns) cancelado(s).`, { lead_id: lead.id });
    return { result: "opt_out", leadId: lead.id };
  }

  if ((await getConversationState(lead.id))?.control === "humano") return { result: "human_controlled", leadId: lead.id };

  await enqueueAgentTask({
    agent: "seller",
    kind: CONVERSATION_RESPOND,
    payload: { lead_id: lead.id, message_id: recorded.message.id },
    dedupeKey: `${CONVERSATION_RESPOND}:${msg.providerMessageId}`,
  });
  return { result: "queued", leadId: lead.id };
}

/** Mensagens que o próprio gateway enviou aparecem de volta como "enviadas do celular": não são você. */
async function isOwnSend(providerMessageId: string): Promise<boolean> {
  const repo = agentRepo();
  const [sent] = await repo.list("outreach_messages", { where: { provider_message_id: providerMessageId }, limit: 1 });
  if (sent) return true;
  const [notice] = await repo.list("owner_notices", { where: { provider_message_id: providerMessageId }, limit: 1 });
  return Boolean(notice);
}

const OLD_HISTORY_MS = 7 * 86_400_000;

export async function handleHumanMessage(msg: IncomingMessage, now: Date = new Date()): Promise<InboundOutcome> {
  if (await isOwnSend(msg.providerMessageId)) return { result: "own_message" };

  const lead = await findLeadByPhone(msg.peer);
  if (!lead) return { result: "no_lead" };

  const recorded = recordConversationMessage({
    leadId: lead.id,
    direction: "out",
    text: displayText(msg),
    author: "humano",
    providerMessageId: msg.providerMessageId,
    at: msg.at ?? undefined,
  });
  if (recorded.duplicate) return { result: "duplicate" };

  // Histórico antigo reentregue não é você assumindo agora.
  if (msg.at && now.getTime() - Date.parse(msg.at) > OLD_HISTORY_MS) return { result: "no_lead" };

  lead.last_contact_at = recorded.message.created_at;
  lead.updated_at = lead.last_contact_at;
  saveDb();
  const already = (await getConversationState(lead.id))?.control === "humano";
  await patchConversationState(lead.id, { control: "humano", control_reason: "Você respondeu pelo celular", awaiting: "nada", attention_reason: null, proposed_slots: [] });
  const cancelled = await cancelPendingForLead(lead.id, "você assumiu a conversa");
  if (!already) {
    logActivity(lead.id, "nota_adicionada", "Você respondeu pelo celular: o Vendedor parou de escrever neste lead.", null);
    saveDb();
    await logAgentEvent("seller", "info", "conversation.taken_over", `Você assumiu a conversa com ${lead.company_name} pelo celular: o agente parou de escrever nela (${cancelled.cycles + cancelled.approvals + cancelled.tasks} item(ns) cancelado(s)).`, { lead_id: lead.id });
  }
  return { result: "taken_over", leadId: lead.id };
}
