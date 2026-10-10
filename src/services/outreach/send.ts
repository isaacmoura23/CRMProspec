import "server-only";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { checkMessage, isStaleCycle, nextWindowOpen, isWithinWindow, touchDelayDays } from "@/lib/outreach-policy";
import { checkReply } from "@/lib/conversation-policy";
import { FIRST_TOUCH_STATUSES, FOLLOW_UP_STATUSES } from "@/lib/outreach-eligibility";
import { ProviderError, type SendResult, type SendTextInput } from "@/providers/whatsapp/types";
import { logAgentEvent } from "@/services/agents/log";
import { enqueueAgentTask } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig, isGloballyEnabled } from "@/services/agents/settings";
import { logActivity } from "@/services/activity";
import { setLeadStatus } from "@/services/lead-service";
import { blockPhone, isBlocked } from "@/services/outreach/blocklist";
import { getConversationState, handOffToHuman, isHumanControlled, patchConversationState, recordConversationMessage } from "@/services/conversation/state";
import { sendGate, windowOf } from "@/services/outreach/gate";
import { whatsappGateway } from "@/services/whatsapp/config";
import type { Lead } from "@/types";
import type { OutreachCycle } from "@/types/agents";

/**
 * Processamento dos ciclos de envio. Portado do `processCycle` da Cobra
 * (agenteitalo/src/server/scheduling/send.ts), com a política do Vendedor.
 *
 * Princípios herdados dela, todos cobertos por teste:
 *   - **reivindicação atômica**: dois processadores nunca enviam o mesmo ciclo;
 *   - **revalidar no instante do envio**: o que valia na aprovação pode não valer
 *     mais (lead respondeu, número bloqueado, modo pausado);
 *   - **esperar não é falhar**: desconexão, modo de teste, janela fechada e teto
 *     do dia devolvem o ciclo à fila SEM contar tentativa;
 *   - **etapa obsoleta não sai**: mensagem de dias atrás não é enviada como se
 *     fosse de hoje;
 *   - **sem confirmação, nunca reenviar**: um timeout vira "incerto" e espera
 *     conferência humana, porque reenviar pode duplicar a mensagem ao lead.
 */

export const MAX_TECHNICAL_ATTEMPTS = 4;
const RECHECK_MS = 60_000;
const CONFIG_WAIT_MS = 10 * 60_000;
const STUCK_CLAIM_MS = 10 * 60_000;
/** Uma resposta parada por mais que isto já não responde ao que o lead disse. */
const REPLY_STALE_MS = 48 * 3_600_000;

/** O mínimo do gateway que o envio usa (injetável nos testes). */
export interface OutreachGateway {
  status(): Promise<{ status: string; dryRun: boolean }>;
  sendText(input: SendTextInput): Promise<SendResult>;
}

export interface OutreachDeps {
  now?: () => Date;
  gateway?: () => OutreachGateway | null;
}

export type CycleOutcome =
  | { result: "sent"; messageId: string }
  | { result: "skipped"; reason: string }
  | { result: "deferred"; reason: string; until: Date; global: boolean }
  | { result: "retry"; reason: string }
  | { result: "failed"; reason: string }
  | { result: "uncertain"; reason: string }
  | { result: "already_processed" };

const nowOf = (deps: OutreachDeps) => (deps.now ?? (() => new Date()))();

function ownerUserId(): string | null {
  const users = getDb().users;
  return users.find((u) => u.role === "owner")?.id ?? users[0]?.id ?? null;
}

function notifyOwner(title: string, body: string | null) {
  const db = getDb();
  const userId = ownerUserId();
  if (!userId) return;
  db.notifications.unshift({
    id: uid("ntf"),
    organization_id: db.organization.id,
    user_id: userId,
    title,
    body,
    link: "/agentes/vendedor",
    read: false,
    created_at: new Date().toISOString(),
  });
}

/** Erro de instalação (token ou segredo trocado, envio desligado): a mensagem não tem culpa, então espera. */
function isConfigError(err: ProviderError): boolean {
  return err.kind === "AUTH" || err.providerCode === 403 || err.providerCode === 501;
}

export async function processCycle(cycleId: string, deps: OutreachDeps = {}): Promise<CycleOutcome> {
  const repo = agentRepo();
  const now = nowOf(deps);
  const nowIso = now.toISOString();

  // 1) Reivindicação atômica: quem não leva, não envia.
  const cycle = await repo.claimOutreachCycle(cycleId);
  if (!cycle) return { result: "already_processed" };

  const touch = async (patch: Partial<OutreachCycle>) => {
    await repo.update("outreach_cycles", cycle.id, { ...patch, updated_at: new Date().toISOString() });
  };
  /**
   * Volta à fila sem contar tentativa.
   *
   * Por padrão mantém a data prevista (`scheduled_for`), que é o que permite
   * perceber que a etapa ficou para trás por uma interrupção (desconexão, pausa).
   * Com `planned`, a espera É o plano — janela fechada, teto do dia, intervalo
   * entre envios — e a data prevista passa a ser o novo horário: uma mensagem
   * aprovada num sábado sai na segunda de manhã, sem ser tomada por obsoleta.
   */
  const defer = async (reason: string, until: Date, global = false, planned = false): Promise<CycleOutcome> => {
    await touch({
      status: "agendado",
      claimed_at: null,
      not_before: until.toISOString(),
      last_error: reason,
      ...(planned ? { scheduled_for: until.toISOString() } : {}),
    });
    return { result: "deferred", reason, until, global };
  };
  const skip = async (reason: string): Promise<CycleOutcome> => {
    await touch({ status: "pulado", skip_reason: reason, claimed_at: null });
    await logAgentEvent("seller", "info", "outreach.skipped", `Mensagem para ${leadName()} não enviada: ${reason}.`, { cycle_id: cycle.id }, null);
    return { result: "skipped", reason };
  };

  const lead = getDb().leads.find((l) => l.id === cycle.lead_id) ?? null;
  const leadName = () => lead?.company_name ?? "lead removido";

  // 2) Modo e interruptor: pausar o agente congela a fila, não a destrói.
  const [globalOn, mode, cfg] = await Promise.all([isGloballyEnabled(), getAgentMode("seller"), getSellerConfig()]);
  if (!globalOn || mode === "pausado") return defer("agente pausado", new Date(now.getTime() + RECHECK_MS), true);

  // 3) O que valia na aprovação pode não valer mais.
  if (!lead || lead.archived) return skip("lead removido ou arquivado");
  if (await isBlocked(cycle.phone)) return skip("número na lista de bloqueio");
  if (await isHumanControlled(cycle.lead_id)) return skip("você assumiu a conversa");
  const isReply = cycle.kind === "resposta";
  if (isReply) {
    // Responder vale em qualquer etapa em que o lead ainda está vivo.
    if (lead.status === "perdido" || lead.status === "fechado") return skip(`o lead está em "${lead.status}"`);
  } else {
    const allowed = cycle.touch === 1 ? FIRST_TOUCH_STATUSES : FOLLOW_UP_STATUSES;
    if (!allowed.includes(lead.status)) return skip(`o lead mudou de estado (${lead.status})`);
  }

  // 4) Aprovação: em modo de aprovação, só sai o que o dono aprovou.
  if (cycle.approval_id) {
    const approval = await repo.get("approvals", cycle.approval_id);
    if (approval?.status !== "aprovado") return skip("o pedido de aprovação não está aprovado");
  } else if (mode === "aprovacao") {
    return defer("em modo de aprovação, esta mensagem não foi aprovada", new Date(now.getTime() + 5 * RECHECK_MS), true);
  }

  // 5) Etapa obsoleta: não envia mensagem velha como se fosse de hoje.
  if (isReply) {
    // Resposta parada há mais de dois dias (desconexão, pausa) já não responde ao que o lead disse: passa para uma pessoa.
    if (now.getTime() - Date.parse(cycle.scheduled_for) > REPLY_STALE_MS) {
      await touch({ status: "pulado", skip_reason: "resposta ficou para trás", claimed_at: null });
      await handOffToHuman(lead, "A resposta ao lead ficou parada por mais de dois dias e não foi enviada: veja a conversa e responda você.");
      return { result: "skipped", reason: "resposta ficou para trás" };
    }
    // Horários propostos que passaram antes de a mensagem sair não podem mais ser oferecidos.
    const conv = await getConversationState(lead.id);
    if (conv?.awaiting === "horario" && conv.proposed_slots.some((s) => Date.parse(s) < now.getTime() + 3_600_000)) {
      await touch({ status: "pulado", skip_reason: "horários propostos já passaram", claimed_at: null });
      await handOffToHuman(lead, "Os horários propostos passaram antes de a mensagem sair: combine você um novo horário.");
      return { result: "skipped", reason: "horários propostos já passaram" };
    }
  } else if (isStaleCycle(new Date(cycle.scheduled_for), now)) {
    await touch({ status: "pulado", skip_reason: "etapa obsoleta", claimed_at: null });
    await enqueueAgentTask({
      agent: "seller",
      kind: "outreach.prepare",
      payload: { lead_id: cycle.lead_id, touch: cycle.touch },
      dedupeKey: `outreach.prepare:${cycle.lead_id}:${cycle.touch}:replan:${cycle.id}`,
    });
    await logAgentEvent("seller", "info", "outreach.stale", `Mensagem para ${leadName()} ficou para trás e será preparada de novo.`, { cycle_id: cycle.id });
    return { result: "skipped", reason: "etapa obsoleta" };
  }

  // 6) Janela de envio.
  const window = windowOf(cfg);
  if (!isWithinWindow(now, window)) {
    const open = nextWindowOpen(now, window) ?? new Date(now.getTime() + 3_600_000);
    return defer("fora da janela de envio", open, true, true);
  }

  // 7) Teto do dia e intervalo entre envios.
  const gate = await sendGate(now, cfg, { ignoreCap: isReply });
  if (!gate.ok) return defer(gate.reason === "cap" ? "teto diário de envios atingido" : "aguardando o intervalo entre envios", gate.until, true, true);

  // 8) Última barreira do texto, não importa quem o escreveu ou editou.
  const violation = isReply ? checkReply(cycle.body, getDb().company_profile.never_say) : checkMessage(cycle.body);
  if (violation) return skip(`texto reprovado: ${violation}`);

  // 9) Gateway de pé e conectado.
  const gateway = (deps.gateway ?? whatsappGateway)();
  if (!gateway) return defer("gateway do WhatsApp não configurado", new Date(now.getTime() + CONFIG_WAIT_MS), true);
  try {
    const status = await gateway.status();
    if (status.status !== "CONNECTED") return defer(`WhatsApp ${status.status === "QR" ? "aguardando QR Code" : "desconectado"}`, new Date(now.getTime() + RECHECK_MS), true);
  } catch (err) {
    const reason = err instanceof ProviderError && err.kind === "AUTH" ? "gateway recusou o token" : "gateway do WhatsApp inacessível";
    return defer(reason, new Date(now.getTime() + RECHECK_MS), true);
  }

  // 10) Registra a mensagem ANTES de chamar o gateway: se o processo cair depois
  //     do envio, o rastro existe e a conferência encontra.
  const messageId = uid("omsg");
  await repo.insert("outreach_messages", {
    id: messageId,
    organization_id: orgId(),
    lead_id: cycle.lead_id,
    cycle_id: cycle.id,
    phone: cycle.phone,
    body: cycle.body,
    status: "QUEUED",
    provider_message_id: null,
    error_detail: null,
    created_at: nowIso,
    sent_at: null,
    delivered_at: null,
    read_at: null,
  });
  await touch({ message_id: messageId });

  let result: SendResult | null = null;
  let error: ProviderError | null = null;
  try {
    result = await gateway.sendText({ to: cycle.phone, body: cycle.body, clientReference: cycle.idempotency_key });
  } catch (err) {
    error = err instanceof ProviderError ? err : new ProviderError("TEMPORARY", err instanceof Error ? err.message : "erro desconhecido");
  }

  /* ------------------------------ desfechos ------------------------------ */

  if (result) {
    const at = nowOf(deps).toISOString();
    await repo.update("outreach_messages", messageId, { status: "SENT", provider_message_id: result.providerMessageId, sent_at: at });
    await touch({ status: "enviado", sent_at: at, last_error: null, claimed_at: null });
    await afterSent(lead, cycle, now, result.providerMessageId);
    return { result: "sent", messageId };
  }

  const e = error!;
  const dropQueued = () => repo.remove("outreach_messages", { id: messageId });

  // Nada saiu e a culpa não é da mensagem: volta à fila sem contar tentativa.
  if (e.kind === "DISCONNECTED" || e.kind === "DRY_RUN") {
    await dropQueued();
    await touch({ message_id: null });
    return defer(e.kind === "DRY_RUN" ? "gateway em modo de teste: aguardando a ativação dos envios reais" : "WhatsApp desconectado", new Date(now.getTime() + RECHECK_MS), true);
  }
  if (isConfigError(e)) {
    await dropQueued();
    await touch({ message_id: null });
    const reason = `configuração do envio: ${e.message}`;
    // Avisa uma vez por motivo (cada nova espera repetiria o mesmo erro a cada 10 minutos).
    if (cycle.last_error !== reason) {
      await logAgentEvent("seller", "error", "outreach.config", `Envio bloqueado por configuração: ${e.message}`, { cycle_id: cycle.id });
    }
    return defer(reason, new Date(now.getTime() + CONFIG_WAIT_MS), true);
  }

  // Sem confirmação: pode ter chegado. NÃO reenviar; espera conferência humana.
  if (e.uncertain) {
    await repo.update("outreach_messages", messageId, { status: "UNCERTAIN", error_detail: e.message.slice(0, 300) });
    await touch({ status: "incerto", last_error: e.message.slice(0, 300), claimed_at: null });
    await logAgentEvent("seller", "warn", "outreach.uncertain", `Envio para ${leadName()} sem confirmação do WhatsApp: pode ter chegado. NÃO será reenviado.`, { cycle_id: cycle.id });
    notifyOwner("Envio sem confirmação", `A mensagem para ${leadName()} pode ter chegado ou não. Confira no WhatsApp antes de agir.`);
    return { result: "uncertain", reason: e.message };
  }

  // Falha transitória: nova tentativa do MESMO ciclo, com espera crescente.
  if (e.retryable) {
    const attempts = cycle.attempts + 1;
    await dropQueued();
    if (attempts < MAX_TECHNICAL_ATTEMPTS) {
      await touch({ status: "agendado", attempts, claimed_at: null, message_id: null, last_error: e.message.slice(0, 300), not_before: new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)).toISOString() });
      return { result: "retry", reason: e.message };
    }
    await touch({ status: "falhou", attempts, claimed_at: null, message_id: null, last_error: e.message.slice(0, 300) });
    await logAgentEvent("seller", "error", "outreach.failed", `Envio para ${leadName()} falhou depois de ${attempts} tentativas: ${e.message}`, { cycle_id: cycle.id });
    return { result: "failed", reason: e.message };
  }

  // Definitivo.
  await repo.update("outreach_messages", messageId, { status: "FAILED", error_detail: e.message.slice(0, 300) });
  await touch({ status: "falhou", last_error: e.message.slice(0, 300), claimed_at: null });
  if (e.kind === "INVALID_RECIPIENT") {
    await blockPhone(cycle.phone, "sem WhatsApp (confirmado no envio)", "invalid");
    await repo.update("outreach_cycles", cycle.id, { skip_reason: "número sem WhatsApp" });
    lead.has_whatsapp = false;
    lead.updated_at = nowIso;
  }
  await logAgentEvent("seller", "error", "outreach.failed", `Envio para ${leadName()} falhou: ${e.message}`, { cycle_id: cycle.id });
  return { result: "failed", reason: e.message };
}

/** Atualiza o lead e agenda o próximo toque. Só roda depois de o gateway confirmar o envio. */
async function afterSent(lead: Lead, cycle: OutreachCycle, now: Date, providerMessageId: string | null = null) {
  const cfg = await getSellerConfig();
  const at = new Date().toISOString();
  const first = !lead.last_contact_at;
  lead.last_contact_at = at;
  lead.updated_at = at;
  // A mensagem entra no histórico do CRM (/conversas), junto com o que o lead respondeu.
  recordConversationMessage({ leadId: lead.id, direction: "out", text: cycle.body, author: "agente", providerMessageId, at });

  if (cycle.kind === "resposta") {
    logActivity(lead.id, "mensagem_enviada", "Resposta enviada pelo Vendedor no WhatsApp.", null);
    saveDb();
    // A proposta de horários acabou de chegar ao lead: agora sim a próxima resposta dele é uma escolha.
    const conv = await getConversationState(lead.id);
    if (conv && conv.awaiting === "nada" && conv.proposed_slots.length > 0) await patchConversationState(lead.id, { awaiting: "horario" });
    await logAgentEvent("seller", "info", "outreach.sent", `Resposta enviada a ${lead.company_name}.`, { cycle_id: cycle.id });
    return;
  }

  logActivity(lead.id, first ? "primeiro_contato" : "mensagem_enviada", `WhatsApp enviado pelo Vendedor (${cycle.touch}º toque).`, null);
  if (lead.status !== "contatado") setLeadStatus(lead.id, "contatado", null);
  else saveDb();

  await logAgentEvent("seller", "info", "outreach.sent", `Mensagem enviada a ${lead.company_name} (${cycle.touch}º toque).`, { cycle_id: cycle.id });

  if (cycle.touch < cfg.max_touches) {
    const runAt = new Date(now.getTime() + touchDelayDays(cycle.touch, cfg.touch_spacing_days) * 86_400_000);
    await enqueueAgentTask({
      agent: "seller",
      kind: "outreach.prepare",
      payload: { lead_id: lead.id, touch: cycle.touch + 1 },
      runAt,
      dedupeKey: `outreach.prepare:${lead.id}:${cycle.touch + 1}`,
    });
  }
}

/**
 * Um envio "incerto" cuja entrega o WhatsApp acabou confirmando (ele chegou):
 * vira enviado e a sequência de acompanhamentos segue de onde parou.
 */
export async function resolveUncertainCycle(cycleId: string, sentAt: string): Promise<void> {
  const repo = agentRepo();
  const cycle = await repo.get("outreach_cycles", cycleId);
  if (!cycle || cycle.status !== "incerto") return;
  await repo.update("outreach_cycles", cycleId, { status: "enviado", sent_at: sentAt, last_error: null, updated_at: new Date().toISOString() });
  const lead = getDb().leads.find((l) => l.id === cycle.lead_id);
  if (lead) await afterSent(lead, { ...cycle, status: "enviado", sent_at: sentAt }, new Date(sentAt));
  await logAgentEvent("seller", "info", "outreach.resolved", "Um envio que estava sem confirmação foi confirmado pelo WhatsApp: a mensagem chegou.", { cycle_id: cycleId });
}

export interface DueReport {
  processed: number;
  sent: number;
  deferred: number;
  skipped: number;
  failed: number;
}

/**
 * Processa os ciclos vencidos, do mais antigo ao mais novo. Para no primeiro
 * bloqueio **global** (janela, teto, intervalo, gateway fora) — não adianta
 * tentar o resto — e depois de cada envio, porque o intervalo mínimo entre
 * mensagens já vale para a próxima.
 */
export async function processDueOutreach(deps: OutreachDeps = {}, opts: { maxCycles?: number } = {}): Promise<DueReport> {
  const report: DueReport = { processed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0 };
  const nowIso = nowOf(deps).toISOString();
  const due = (await agentRepo().list("outreach_cycles", { where: { status: "agendado" }, orderBy: "scheduled_for", limit: 50 })).filter((c) => c.not_before <= nowIso);

  for (const cycle of due.slice(0, opts.maxCycles ?? 10)) {
    const outcome = await processCycle(cycle.id, deps);
    if (outcome.result === "already_processed") continue;
    report.processed += 1;
    if (outcome.result === "sent") {
      report.sent += 1;
      break;
    }
    if (outcome.result === "deferred") {
      report.deferred += 1;
      if (outcome.global) break;
    } else if (outcome.result === "skipped") report.skipped += 1;
    else report.failed += 1;
  }
  return report;
}

/**
 * Ciclos reivindicados há muito tempo (o processo caiu no meio) viram "incerto":
 * não se sabe se a mensagem saiu, e a regra é nunca reenviar sem saber.
 */
export async function reconcileOutreach(now: Date = new Date()): Promise<number> {
  const repo = agentRepo();
  const staleBefore = new Date(now.getTime() - STUCK_CLAIM_MS).toISOString();
  const stuck = (await repo.list("outreach_cycles", { where: { status: "reivindicado" } })).filter((c) => (c.claimed_at ?? "") < staleBefore);
  for (const c of stuck) {
    await repo.update("outreach_cycles", c.id, {
      status: "incerto",
      last_error: "Processamento interrompido sem confirmação do envio.",
      updated_at: now.toISOString(),
    });
    if (c.message_id) {
      await repo.update("outreach_messages", c.message_id, { status: "UNCERTAIN", error_detail: "Processamento interrompido sem confirmação." });
    }
    await logAgentEvent("seller", "warn", "outreach.uncertain", "Um envio ficou sem desfecho conhecido (o processo foi interrompido) e NÃO será reenviado.", { cycle_id: c.id });
  }
  return stuck.length;
}
