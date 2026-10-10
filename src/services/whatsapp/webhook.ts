import "server-only";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyGatewayEvent } from "@/lib/gateway-signature";
import { gatewayEvent } from "@/lib/gateway-events";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import { whatsappWebhookSecret } from "@/services/whatsapp/config";
import { applySessionStatus } from "@/services/whatsapp/link";

/**
 * Recebimento dos eventos do gateway de WhatsApp.
 *
 * Os códigos de resposta são um contrato com a caixa de saída do gateway
 * (`gateway/outbox.mts`):
 *   2xx           entregue — sai da fila;
 *   400/422       o CRM entendeu e recusou — vira "morto", não trava a fila;
 *   401/403/5xx   problema de segredo, relógio ou do próprio CRM — a fila
 *                 segura e tenta de novo, para quem corrigir ver tudo sair.
 */

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): WebhookResponse => ({ status, body });

export async function handleGatewayWebhook(input: {
  rawBody: string;
  headers: { get(name: string): string | null };
  now?: number;
}): Promise<WebhookResponse> {
  const secret = whatsappWebhookSecret();
  if (!secret) {
    // Sem segredo não há como autenticar ninguém: recusa tudo (e o gateway segura a fila).
    return reply(503, { error: "webhook do WhatsApp não configurado (WHATSAPP_WEBHOOK_SECRET)" });
  }
  if (Buffer.byteLength(input.rawBody) > MAX_WEBHOOK_BODY_BYTES) return reply(413, { error: "corpo grande demais" });

  const verified = verifyGatewayEvent({
    secret,
    timestamp: input.headers.get(TIMESTAMP_HEADER),
    signature: input.headers.get(SIGNATURE_HEADER),
    body: input.rawBody,
    now: input.now,
  });
  if (!verified.ok) return reply(401, { error: "assinatura inválida", reason: verified.reason });

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return reply(400, { error: "JSON inválido" });
  }
  const parsed = gatewayEvent.safeParse(json);
  if (!parsed.success) return reply(400, { error: "evento inválido" });
  const event = parsed.data;

  // O cabeçalho é o que o gateway usa para dizer "este é o evento X": tem de bater com o corpo.
  const headerId = input.headers.get(EVENT_ID_HEADER);
  if (headerId && headerId !== event.id) return reply(400, { error: "id do evento diverge do cabeçalho" });

  const repo = agentRepo();
  // Já recebido (o gateway reenvia até confirmarmos): confirma de novo, sem repetir o efeito.
  if (await repo.get("whatsapp_receipts", event.id)) return reply(200, { ok: true, duplicate: true });

  if (event.type === "session.status") {
    await applySessionStatus(event);
  } else {
    // O gateway só entrega mensagens quando GATEWAY_FORWARD_MESSAGES=1, e isso
    // pertence à fase do Vendedor. Recusar com 422 deixa o evento guardado como
    // "morto" no gateway em vez de descartá-lo em silêncio.
    await logAgentEvent("sistema", "warn", "whatsapp.unhandled", `Evento ${event.type} recebido, mas ainda não é tratado pelo CRM.`);
    return reply(422, { error: "tipo de evento ainda não tratado" });
  }

  // O recibo vem DEPOIS do efeito: se o processamento falhar, o reenvio não é tomado por duplicata.
  try {
    await repo.insert("whatsapp_receipts", {
      id: event.id,
      organization_id: orgId(),
      type: event.type,
      received_at: new Date().toISOString(),
    });
  } catch (err) {
    // Duas entregas simultâneas do mesmo evento: o efeito é idempotente, então tudo bem.
    if (!(err instanceof UniqueViolationError)) throw err;
  }
  return reply(200, { ok: true });
}
