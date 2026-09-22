import { sanitizeHeader } from "@/lib/job-text";

/**
 * Monta uma mensagem MIME (multipart/mixed com alternativa texto/HTML e um
 * anexo PDF) para a Gmail API. Cabeçalhos passam por `sanitizeHeader` para
 * impedir injeção por quebra de linha; assunto em RFC 2047 (UTF-8).
 */

function encodeHeaderWord(value: string): string {
  // Só codifica quando há caracteres fora do ASCII.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string | null;
  messageId: string;
  attachment: { filename: string; content: Uint8Array; contentType: string };
  extraHeaders?: Record<string, string>;
}

export function buildMimeMessage(input: MimeInput): string {
  const mixed = `mixed_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeaderWord(sanitizeHeader(input.subject, 150))}`,
    `Message-ID: <${sanitizeHeader(input.messageId, 120)}>`,
    ...(input.replyTo ? [`Reply-To: ${sanitizeHeader(input.replyTo)}`] : []),
    ...Object.entries(input.extraHeaders ?? {}).map(([k, v]) => `${sanitizeHeader(k, 60)}: ${sanitizeHeader(v)}`),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const lines = [
    ...headers,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.text, "utf-8").toString("base64")),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.html, "utf-8").toString("base64")),
    `--${alt}--`,
    `--${mixed}`,
    `Content-Type: ${input.attachment.contentType}; name="${sanitizeHeader(input.attachment.filename, 100).replace(/"/g, "")}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${sanitizeHeader(input.attachment.filename, 100).replace(/"/g, "")}"`,
    "",
    wrap76(Buffer.from(input.attachment.content).toString("base64")),
    `--${mixed}--`,
    "",
  ];
  return lines.join("\r\n");
}

export function base64Url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}
