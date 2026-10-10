import "server-only";
import { uid } from "@/lib/utils";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import type { OutreachCycle } from "@/types/agents";

/**
 * Criação de ciclos de envio.
 *
 * Um ciclo nasce `agendado` e a política (janela, teto, intervalo, conexão,
 * bloqueio) decide quando — e se — ele vira mensagem. A chave de idempotência é
 * o próprio id do ciclo: vai ao gateway como referência e impede o mesmo ciclo
 * de ser enviado duas vezes, mesmo que alguém tente processá-lo de novo.
 */

export interface NewCycle {
  leadId: string;
  touch: number;
  phone: string;
  body: string;
  approvalId: string | null;
  now?: Date;
}

/** `null` quando o lead já tem uma abordagem em andamento (a regra é do repositório, não de uma checagem apressada). */
export async function createOutreachCycle(input: NewCycle): Promise<OutreachCycle | null> {
  const now = (input.now ?? new Date()).toISOString();
  const id = uid("ocy");
  const cycle: OutreachCycle = {
    id,
    organization_id: orgId(),
    lead_id: input.leadId,
    touch: input.touch,
    phone: input.phone,
    body: input.body,
    status: "agendado",
    scheduled_for: now,
    not_before: now,
    claimed_at: null,
    attempts: 0,
    idempotency_key: id,
    approval_id: input.approvalId,
    skip_reason: null,
    last_error: null,
    message_id: null,
    created_at: now,
    updated_at: now,
    sent_at: null,
  };
  try {
    await agentRepo().insert("outreach_cycles", cycle);
    return cycle;
  } catch (err) {
    if (err instanceof UniqueViolationError) return null;
    throw err;
  }
}

export async function cyclesOfLead(leadId: string): Promise<OutreachCycle[]> {
  return agentRepo().list("outreach_cycles", { where: { lead_id: leadId }, orderBy: "created_at" });
}
