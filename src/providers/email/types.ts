/**
 * Contrato dos canais de e-mail de candidatura.
 *
 * Um envio é sempre individual (um destinatário) com o PDF anexado. O
 * resultado distingue aceite pelo provedor de falhas definitivas,
 * transitórias e do caso "incerto" (timeout depois de a requisição sair).
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string | null;
  attachment: { filename: string; content: Uint8Array; contentType: "application/pdf" };
  /** Reutilizada nos retries da mesma tentativa lógica. */
  idempotencyKey: string;
  /** Identificador interno para rastrear a mensagem (cabeçalho). */
  applicationId: string;
}

export type SendOutcome =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "rejected"; error: string; permanent: boolean }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "uncertain"; error: string };

export interface EmailChannel {
  id: "resend" | "gmail";
  name: string;
  isConfigured(): boolean;
  send(email: OutgoingEmail): Promise<SendOutcome>;
}
