import "server-only";
import { agentRepo } from "@/services/agents/repository";
import { resolveUncertainCycle } from "@/services/outreach/send";
import type { OutreachMessage, OutreachMessageStatus } from "@/types/agents";

/**
 * Estado de entrega das mensagens enviadas, como o WhatsApp o confirma.
 *
 * O estado só avança (QUEUED < SENT < DELIVERED < READ); um evento atrasado ou
 * repetido não pode regredir uma mensagem já lida. É o que a Cobra faz em
 * `applyDeliveryStatus`. FAILED é terminal.
 */

const RANK: Record<OutreachMessageStatus, number> = { QUEUED: 0, UNCERTAIN: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 9 };

export type DeliveryStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

/** Devolve `true` se a mensagem existe (mesmo que o estado não tenha avançado). */
export async function applyDeliveryStatus(input: { providerMessageId: string; status: DeliveryStatus; at: string }): Promise<boolean> {
  const repo = agentRepo();
  const [message] = await repo.list("outreach_messages", { where: { provider_message_id: input.providerMessageId }, limit: 1 });
  // O gateway também avisa das mensagens que você mandou pelo celular: não são do Vendedor.
  if (!message) return false;

  if (RANK[input.status] <= RANK[message.status]) return true;
  // O repositório local devolve o objeto guardado e o update o altera no lugar:
  // o estado anterior precisa ser lido antes.
  const wasUncertain = message.status === "UNCERTAIN";

  const patch: Partial<OutreachMessage> = { status: input.status };
  if (input.status === "SENT" && !message.sent_at) patch.sent_at = input.at;
  // Entregue/lido implica enviado: quem chegou antes de "enviado" não deixa buraco na linha do tempo.
  if (input.status === "DELIVERED" || input.status === "READ") {
    patch.sent_at = message.sent_at ?? input.at;
    patch.delivered_at = message.delivered_at ?? input.at;
  }
  if (input.status === "READ") patch.read_at = input.at;
  await repo.update("outreach_messages", message.id, patch);
  // Estava sem confirmação e o WhatsApp acaba de confirmar: a dúvida se resolve sozinha.
  if (wasUncertain && input.status !== "FAILED") {
    await resolveUncertainCycle(message.cycle_id, patch.sent_at ?? input.at);
  }
  return true;
}
