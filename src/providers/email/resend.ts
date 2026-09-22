import "server-only";
import { isValidEmail, sanitizeHeader } from "@/lib/job-text";
import type { EmailChannel, OutgoingEmail, SendOutcome } from "@/providers/email/types";

/**
 * Resend — canal principal de candidaturas.
 *
 * API: POST https://api.resend.com/emails (https://resend.com/docs/api-reference/emails/send-email).
 * Só no servidor, com RESEND_API_KEY e RESEND_FROM_EMAIL (remetente de
 * domínio verificado — @gmail.com não é aceito porque o domínio precisa
 * pertencer ao operador). O envio em lote não é usado: a API Batch não
 * aceita anexos, então cada candidatura é uma chamada individual pela fila.
 *
 * A chave `Idempotency-Key` faz o Resend devolver o mesmo e-mail se a
 * mesma tentativa for repetida em até 24 h — é o que torna seguro
 * reenviar depois de um timeout. Nossa deduplicação persistente cobre o
 * resto.
 */

const TIMEOUT_MS = 20_000;

export function resendFromAddress(): string | null {
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!from) return null;
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  if (!isValidEmail(addr)) return null;
  if (/@(gmail|hotmail|outlook|yahoo|icloud)\./i.test(addr)) return null;
  return from;
}

export function resendConfigProblem(): string | null {
  if (!process.env.RESEND_API_KEY) return "RESEND_API_KEY não definida.";
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!from) return "RESEND_FROM_EMAIL não definida.";
  if (!resendFromAddress()) return "RESEND_FROM_EMAIL precisa ser um endereço de domínio próprio verificado no Resend (provedores como Gmail não servem).";
  return null;
}

export class ResendChannel implements EmailChannel {
  id = "resend" as const;
  name = "Resend";

  isConfigured() {
    return resendConfigProblem() === null;
  }

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    const from = resendFromAddress();
    const key = process.env.RESEND_API_KEY;
    if (!from || !key) return { kind: "rejected", error: resendConfigProblem() ?? "Resend não configurado", permanent: true };
    if (!isValidEmail(email.to)) return { kind: "rejected", error: "Destinatário inválido", permanent: true };

    const body = {
      from,
      to: [email.to],
      subject: sanitizeHeader(email.subject, 150),
      text: email.text,
      html: email.html,
      ...(email.replyTo && isValidEmail(email.replyTo) ? { reply_to: email.replyTo } : {}),
      attachments: [
        { filename: sanitizeHeader(email.attachment.filename, 100), content: Buffer.from(email.attachment.content).toString("base64"), content_type: "application/pdf" },
      ],
      headers: { "X-ProspecAtlas-Application": sanitizeHeader(email.applicationId, 80) },
    };

    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": sanitizeHeader(email.idempotencyKey, 256),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A requisição pode ter saído e sido aceita antes do timeout: não é
      // falha nem sucesso. A reconciliação reenvia com a mesma chave.
      return { kind: "uncertain", error: err instanceof Error ? err.message : "Erro de rede" };
    }

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "0");
      return { kind: "rate_limited", retryAfterMs: (Number.isFinite(retry) && retry > 0 ? retry : 10) * 1000 };
    }
    let data: { id?: string; message?: string; name?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      /* corpo vazio */
    }
    if (res.ok && data.id) return { kind: "accepted", providerMessageId: data.id };
    const message = data.message ?? `Resend respondeu ${res.status}`;
    // 4xx = pedido inválido (domínio não verificado, destinatário ruim): não adianta repetir.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408;
    return { kind: "rejected", error: message, permanent };
  }
}
