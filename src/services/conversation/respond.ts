import "server-only";
import { aiClassifyResponse } from "@/ai";
import type { ClassificationOutput } from "@/ai/schemas";
import { buildReply, checkReply, formatSlot, isPlainAgreement, parseSlotChoice, proposeSlots, type MeetingAvailability, type ReplyKind } from "@/lib/conversation-policy";
import { leadForMessage } from "@/lib/outreach-eligibility";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { APPROVAL_TTL_MS } from "@/services/agents/approvals";
import { PermanentTaskError, registerAgentHandler, type AgentTaskContext } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { emitEvent } from "@/services/events";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import { setLeadStatus } from "@/services/lead-service";
import { CONVERSATION_RESPOND, isMediaPlaceholder } from "@/services/conversation/inbound";
import { createMeeting, upcomingMeetingTimes } from "@/services/conversation/meetings";
import { createOutreachCycle } from "@/services/outreach/cycles";
import {
  cancelPendingForLead,
  getConversationState,
  handOffToHuman,
  inboundSinceLastOut,
  patchConversationState,
  wasContactedByAgent,
} from "@/services/conversation/state";
import type { Lead } from "@/types";
import type { Approval } from "@/types/agents";

/**
 * Decide o que fazer com o que o lead respondeu.
 *
 * O modelo (quando há chave) só ESCOLHE UMA CATEGORIA de uma lista fechada.
 * Todo o resto é código daqui: para quem responder (sempre o telefone que o
 * Vendedor já confirmou, nunca um número vindo do texto), o texto da resposta
 * (modelos fixos, com as barreiras de `checkReply`), que horário propor e se a
 * resposta precisa do seu clique. O texto do lead nunca vira instrução.
 */

type Category = ClassificationOutput["classification"];

/** Abaixo disso, ou nas categorias vagas, a conversa passa para uma pessoa. */
export const MIN_CONFIDENCE = 0.5;

export interface Classified {
  category: Category;
  confidence: number;
  reasoning: string;
  model: string;
}

export async function classifyInbound(text: string): Promise<Classified> {
  const { output, model } = await aiClassifyResponse(text);
  const vague = output.classification === "outra" || output.classification === "informacao_insuficiente";
  return { category: output.classification, confidence: vague ? 0.3 : 0.85, reasoning: output.reasoning, model };
}

const INTEREST: ReadonlySet<Category> = new Set(["interessado", "quer_saber_mais", "quer_reuniao", "quer_proposta", "preco"]);

const REPLY_LABEL: Record<ReplyKind, string> = {
  propor_horarios: "Propor horários de reunião",
  preco: "Responder sobre valores e propor reunião",
  confirmar_reuniao: "Confirmar a reunião",
  retorno_futuro: "Combinar retorno mais para frente",
  sem_prioridade: "Reconhecer que não é prioridade",
  ja_possui_fornecedor: "Deixar a porta aberta",
};

function availabilityOf(cfg: Awaited<ReturnType<typeof getSellerConfig>>): MeetingAvailability {
  return { days: cfg.meeting_days, startHour: cfg.meeting_start_hour, endHour: cfg.meeting_end_hour, minNoticeHours: cfg.meeting_min_notice_hours, durationMin: cfg.meeting_duration_min };
}

/** O telefone que o Vendedor já confirmou como WhatsApp deste lead — o único destino de uma resposta. */
async function confirmedPhone(leadId: string): Promise<string | null> {
  const sent = await agentRepo().list("outreach_messages", { where: { lead_id: leadId }, orderBy: "created_at", desc: true, limit: 1 });
  return sent[0]?.phone ?? null;
}

export interface QueuedReply {
  kind: "approval" | "cycle";
  id: string;
}

/**
 * Coloca uma resposta a caminho: pede a sua aprovação (modo de aprovação) ou
 * agenda o envio. Respostas anteriores ainda não enviadas são substituídas: o
 * lead escreveu de novo, a resposta velha já não vale.
 */
export async function queueReply(lead: Lead, phone: string, kind: ReplyKind, body: string, sourceMessageId: string): Promise<QueuedReply | { rejected: string }> {
  const profile = getDb().company_profile;
  const violation = checkReply(body, profile.never_say);
  if (violation) return { rejected: violation };

  await cancelPendingForLead(lead.id, "substituída por uma resposta mais nova");
  const mode = await getAgentMode("seller");
  if (mode === "aprovacao") {
    const now = Date.now();
    const approval: Approval = {
      id: uid("apv"),
      organization_id: orgId(),
      agent: "seller",
      kind: "conversation_reply",
      title: `Resposta para ${lead.company_name}`,
      detail: `${REPLY_LABEL[kind]} · ${phone}`,
      payload: { lead_id: lead.id, phone, body, intent: kind, source_message_id: sourceMessageId },
      dedupe_key: `reply:${lead.id}:${sourceMessageId}`,
      status: "pendente",
      decided_by: null,
      decided_at: null,
      task_id: null,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    await agentRepo().insert("approvals", approval);
    await logAgentEvent("seller", "info", "approval.requested", `Pediu aprovação da resposta para ${lead.company_name}.`, { lead_id: lead.id });
    return { kind: "approval", id: approval.id };
  }
  const cycle = await createOutreachCycle({ leadId: lead.id, kind: "resposta", touch: 0, phone, body, approvalId: null });
  if (!cycle) return { rejected: "já há um envio em andamento para este lead" };
  await logAgentEvent("seller", "info", "outreach.scheduled", `Resposta para ${lead.company_name} agendada.`, { cycle_id: cycle.id, lead_id: lead.id });
  return { kind: "cycle", id: cycle.id };
}

function tag(messageId: string | null, classification: string) {
  if (!messageId) return;
  const m = getDb().messages.find((x) => x.id === messageId);
  if (m) m.classification = classification;
}

async function respond(ctx: AgentTaskContext): Promise<void> {
  const payload = ctx.task.payload as { lead_id?: string; message_id?: string };
  if (!payload.lead_id) throw new PermanentTaskError("Tarefa sem lead.");

  await ensureLeadsLoaded();
  const lead = getDb().leads.find((l) => l.id === payload.lead_id);
  if (!lead || lead.archived) {
    ctx.setResult({ skipped: "lead não encontrado" });
    return;
  }
  const state = await getConversationState(lead.id);
  if (state?.control === "humano") {
    ctx.setResult({ skipped: "conversa assumida por você" });
    return;
  }
  if (lead.status === "perdido" || lead.status === "fechado") {
    ctx.setResult({ skipped: `lead em "${lead.status}"` });
    return;
  }

  // Uma rajada de mensagens é tratada de uma vez, pela mais nova.
  const { text, lastMessageId } = inboundSinceLastOut(lead.id);
  if (!text || lastMessageId !== payload.message_id) {
    ctx.setResult({ skipped: "há uma mensagem mais nova; é ela que decide" });
    return;
  }

  if (!(await wasContactedByAgent(lead.id))) {
    await handOffToHuman(lead, "Escreveu sem ter sido abordado pelo Vendedor: decida você como responder.");
    ctx.setResult({ handoff: "não abordado pelo Vendedor" });
    return;
  }
  const phone = await confirmedPhone(lead.id);
  if (!phone) {
    await handOffToHuman(lead, "Não há telefone confirmado para responder.");
    ctx.setResult({ handoff: "sem telefone confirmado" });
    return;
  }
  if (isMediaPlaceholder(text)) {
    await handOffToHuman(lead, "Mandou áudio, imagem ou documento: o agente não interpreta mídia.");
    ctx.setResult({ handoff: "mídia" });
    return;
  }

  const cfg = await getSellerConfig();
  const now = new Date();
  const contactName = leadForMessage(lead).contact_name;
  const sourceId = payload.message_id ?? uid("src");

  // 1) Estava esperando a escolha de um horário?
  if (state?.awaiting === "horario" && state.proposed_slots.length > 0) {
    const slots = state.proposed_slots.map((s) => new Date(s));
    const choice = parseSlotChoice(text, slots) ?? (slots.length === 1 && isPlainAgreement(text) ? 0 : null);
    if (choice !== null) {
      const at = slots[choice]!;
      if (at.getTime() < now.getTime() + 3_600_000) {
        await handOffToHuman(lead, "Escolheu um horário que já passou ou está muito perto: combine você o novo horário.");
        ctx.setResult({ handoff: "horário vencido" });
        return;
      }
      const busy = await upcomingMeetingTimes(now);
      if (busy.some((b) => Math.abs(b.getTime() - at.getTime()) < cfg.meeting_duration_min * 60_000)) {
        await handOffToHuman(lead, "O horário escolhido acabou de ser ocupado por outra reunião: combine você o novo horário.");
        ctx.setResult({ handoff: "horário ocupado" });
        return;
      }
      const meeting = await createMeeting({ lead, at, interestText: state.interest_text ?? text });
      tag(lastMessageId, "quer_reuniao");
      await patchConversationState(lead.id, { awaiting: "nada", proposed_slots: [], attention_reason: null, last_classification: "reuniao_marcada" });
      const reply = await queueReply(lead, phone, "confirmar_reuniao", buildReply("confirmar_reuniao", { confirmed: formatSlot(at) }), sourceId);
      saveDb();
      ctx.setResult({ meeting_id: meeting.id, at: meeting.at, reply: "rejected" in reply ? reply.rejected : reply.kind });
      return;
    }
    // Não escolheu nenhum dos dois: o agente não adivinha.
    const c = await classifyInbound(text);
    tag(lastMessageId, c.category);
    if (c.category === "sem_interesse") return closeLead(ctx, lead, text, c);
    await handOffToHuman(lead, "Não ficou claro qual horário a pessoa escolheu: confira a conversa e combine você.");
    ctx.setResult({ handoff: "horário não identificado", category: c.category });
    return;
  }

  // 2) Conversa normal: classifica e decide.
  const c = await classifyInbound(text);
  tag(lastMessageId, c.category);
  await patchConversationState(lead.id, { last_classification: c.category });
  await ctx.log("info", `${lead.company_name}: ${c.category} (${c.model}).`);

  if (c.confidence < MIN_CONFIDENCE) {
    await handOffToHuman(lead, `Resposta que o agente não sabe tratar com segurança ("${text.slice(0, 80)}"): responda você.`);
    ctx.setResult({ handoff: "baixa confiança", category: c.category });
    return;
  }

  if (c.category === "sem_interesse") return closeLead(ctx, lead, text, c);

  const profileName = getDb().company_profile.company_name;
  let kind: ReplyKind;
  let slotsIso: string[] = [];
  let body: string;

  if (INTEREST.has(c.category)) {
    await recordInterest(lead, text);
    const slots = proposeSlots(now, availabilityOf(cfg), { busy: await upcomingMeetingTimes(now) });
    if (slots.length === 0) {
      await handOffToHuman(lead, "A pessoa tem interesse, mas não há horário livre na disponibilidade configurada: marque você.");
      ctx.setResult({ handoff: "sem horário livre", category: c.category });
      return;
    }
    kind = c.category === "preco" ? "preco" : "propor_horarios";
    slotsIso = slots.map((s) => s.toISOString());
    body = buildReply(kind, { contactName, senderName: profileName, slots: slots.map((s) => formatSlot(s)) });
  } else if (c.category === "sem_prioridade" || c.category === "pediu_retorno_futuro") {
    kind = c.category === "sem_prioridade" ? "sem_prioridade" : "retorno_futuro";
    lead.next_follow_up_at = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    lead.updated_at = now.toISOString();
    saveDb();
    body = buildReply(kind, { contactName });
  } else if (c.category === "ja_possui_fornecedor") {
    kind = "ja_possui_fornecedor";
    body = buildReply(kind, { contactName });
  } else {
    await handOffToHuman(lead, `Resposta fora do que o agente trata (${c.category}): responda você.`);
    ctx.setResult({ handoff: c.category });
    return;
  }

  const queued = await queueReply(lead, phone, kind, body, sourceId);
  if ("rejected" in queued) {
    await handOffToHuman(lead, `A resposta automática foi recusada pela política (${queued.rejected}): responda você.`);
    ctx.setResult({ handoff: queued.rejected, category: c.category });
    return;
  }
  // Os horários ficam guardados, mas só passam a "esperar escolha" quando a mensagem com eles SAIR:
  // enquanto espera aprovação ou a janela, o lead ainda não os viu.
  await patchConversationState(lead.id, { awaiting: "nada", proposed_slots: slotsIso, attention_reason: null });
  ctx.setResult({ category: c.category, reply: kind, [queued.kind === "approval" ? "approval_id" : "cycle_id"]: queued.id });
}

/** O interesse explícito fica registrado: é a prova que a construção do site vai exigir. */
async function recordInterest(lead: Lead, text: string) {
  const state = await getConversationState(lead.id);
  if (!state?.interest_text) await patchConversationState(lead.id, { interest_text: text.slice(0, 500), interest_at: new Date().toISOString() });
  if (lead.status !== "interessado" && lead.status !== "reuniao") {
    setLeadStatus(lead.id, "interessado", null);
    logActivity(lead.id, "nota_adicionada", `Demonstrou interesse: "${text.slice(0, 120)}"`, null);
    saveDb();
    emitEvent("lead.interested", lead, { payload: { message: text.slice(0, 500) } });
    saveDb();
  }
}

/** Recusa clara que não é pedido para parar: encerra a abordagem, sem responder e sem insistir. */
async function closeLead(ctx: AgentTaskContext, lead: Lead, text: string, c: Classified) {
  await cancelPendingForLead(lead.id, "o lead não tem interesse");
  setLeadStatus(lead.id, "perdido", null);
  logActivity(lead.id, "perda", `Sem interesse: "${text.slice(0, 100)}"`, null);
  saveDb();
  await patchConversationState(lead.id, { awaiting: "nada", attention_reason: null, proposed_slots: [], last_classification: "sem_interesse" });
  await logAgentEvent("seller", "info", "conversation.closed", `${lead.company_name} não tem interesse: abordagem encerrada, sem novas mensagens.`, { lead_id: lead.id });
  ctx.setResult({ closed: true, category: c.category });
}

export function registerConversationHandlers() {
  registerAgentHandler(CONVERSATION_RESPOND, respond);
}
