import { z } from "zod";

/**
 * Contrato dos eventos que o gateway de WhatsApp entrega ao CRM.
 *
 * Fica em `src/lib` (sem `server-only`) porque os dois lados o importam: o
 * gateway para montar o evento, o CRM para validar o que chegou. Um evento
 * desconhecido ou malformado é recusado na borda — nada de campo solto
 * entrando no domínio.
 */

export const SESSION_STATUSES = ["DISCONNECTED", "QR", "CONNECTING", "CONNECTED", "NEEDS_RECONNECT"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const base = z.object({
  /** Identificador único do evento: é a chave de deduplicação no CRM. */
  id: z.string().min(8).max(80),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  occurred_at: z.string().datetime(),
});

export const sessionStatusEvent = base.extend({
  type: z.literal("session.status"),
  data: z.object({
    status: z.enum(SESSION_STATUSES),
    phone: z.string().nullable(),
    push_name: z.string().nullable(),
    last_error: z.string().nullable(),
    /** Gateway em modo de teste: nada sai pelo WhatsApp. */
    dry_run: z.boolean(),
  }),
});

/** Mensagem de contato individual (nunca grupo, nunca status). */
const messageData = z.object({
  provider_message_id: z.string().min(1).max(120),
  /** Telefone do contato em E.164. */
  peer: z.string().regex(/^\+\d{10,15}$/),
  text: z.string().max(10_000),
  media_type: z.string().nullable(),
  profile_name: z.string().nullable(),
  /** Quando a mensagem foi escrita (o do evento é o da entrega). Ausente em gateways antigos. */
  message_at: z.string().datetime().nullable().optional(),
});

export const messageReceivedEvent = base.extend({
  type: z.literal("message.received"),
  data: messageData,
});

/** O dono respondeu pelo próprio celular: pausa o agente naquele lead. */
export const messageFromPhoneEvent = base.extend({
  type: z.literal("message.from_phone"),
  data: messageData,
});

export const messageDeliveryEvent = base.extend({
  type: z.literal("message.delivery"),
  data: z.object({
    provider_message_id: z.string().min(1).max(120),
    status: z.enum(["SENT", "DELIVERED", "READ", "FAILED"]),
  }),
});

export const gatewayEvent = z.discriminatedUnion("type", [
  sessionStatusEvent,
  messageReceivedEvent,
  messageFromPhoneEvent,
  messageDeliveryEvent,
]);

export type GatewayEvent = z.infer<typeof gatewayEvent>;
export type SessionStatusEvent = z.infer<typeof sessionStatusEvent>;
