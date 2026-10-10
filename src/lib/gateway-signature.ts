import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Assinatura dos eventos que o gateway de WhatsApp entrega ao CRM.
 *
 * O gateway e o CRM são processos separados que só se falam por HTTP; sem
 * assinatura, qualquer um que descobrisse a URL do webhook poderia forjar
 * "o lead respondeu" ou "o número está conectado".
 *
 * O MAC cobre o instante e o corpo bruto (`<timestamp>.<corpo>`): assinar só o
 * corpo deixaria um evento capturado valer para sempre. O receptor recusa o que
 * estiver fora da janela de tolerância e deduplica pelo id do evento.
 */

export const SIGNATURE_HEADER = "x-gateway-signature";
export const TIMESTAMP_HEADER = "x-gateway-timestamp";
export const EVENT_ID_HEADER = "x-gateway-event-id";

/** Quanto o relógio dos dois lados pode divergir (e quanto um evento capturado vale). */
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export function signGatewayEvent(secret: string, timestamp: number | string, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" };

export function verifyGatewayEvent(input: {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  now?: number;
  toleranceMs?: number;
}): VerifyResult {
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };

  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (input.toleranceMs ?? DEFAULT_TOLERANCE_MS)) {
    return { ok: false, reason: "stale" };
  }

  const expected = Buffer.from(signGatewayEvent(input.secret, timestamp, input.body));
  const received = Buffer.from(signature);
  // timingSafeEqual exige o mesmo tamanho; tamanho diferente já é divergência.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
