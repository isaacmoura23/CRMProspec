import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Autorização de envio: a prova de que o CRM mandou esta mensagem.
 *
 * O token do gateway abre a porta; esta autorização é o que o gateway exige
 * para **enviar de verdade**. O CRM só a emite depois de passar pela política
 * (janela, teto, intervalo, bloqueio, aprovação) e ela amarra tudo o que
 * importa — a sessão, o destinatário, o texto exato, a referência do ciclo e
 * um prazo curto. Consequência: quem obtiver o token do gateway não consegue
 * mandar texto arbitrário a ninguém, e uma autorização capturada não serve
 * para outro texto, outro número nem depois de 2 minutos.
 *
 * Usa o mesmo segredo dos webhooks, com um prefixo (`send|`) que impede uma
 * assinatura de evento de ser tomada por autorização e vice-versa.
 */

export const SEND_AUTH_TTL_MS = 2 * 60_000;

export interface SendAuthInput {
  sessionId: string;
  to: string;
  text: string;
  reference: string;
}

export interface SendAuthorization {
  expires_at: number;
  signature: string;
}

function mac(secret: string, input: SendAuthInput, expiresAt: number): string {
  const textHash = createHash("sha256").update(input.text).digest("hex");
  return createHmac("sha256", secret)
    .update(`send|${input.sessionId}|${input.to}|${textHash}|${input.reference}|${expiresAt}`)
    .digest("hex");
}

export function mintSendAuthorization(secret: string, input: SendAuthInput, now = Date.now(), ttlMs = SEND_AUTH_TTL_MS): SendAuthorization {
  const expires_at = now + ttlMs;
  return { expires_at, signature: mac(secret, input, expires_at) };
}

export type SendAuthResult = { ok: true } | { ok: false; reason: "missing" | "expired" | "mismatch" };

export function verifySendAuthorization(
  secret: string,
  input: SendAuthInput,
  authorization: Partial<SendAuthorization> | null | undefined,
  now = Date.now()
): SendAuthResult {
  if (!authorization || typeof authorization.signature !== "string" || typeof authorization.expires_at !== "number") {
    return { ok: false, reason: "missing" };
  }
  if (!Number.isFinite(authorization.expires_at) || authorization.expires_at < now) return { ok: false, reason: "expired" };
  const expected = Buffer.from(mac(secret, input, authorization.expires_at));
  const received = Buffer.from(authorization.signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
