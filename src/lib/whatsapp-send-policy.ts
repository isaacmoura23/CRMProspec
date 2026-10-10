/**
 * Regras puras do envio de WhatsApp, compartilhadas pelo gateway e pelo CRM.
 * `recipientJid` e `isSimulatedMessage` vêm do projeto Cobra (agenteitalo).
 */

/** Respostas simuladas do gateway em modo de teste ou do provedor de demonstração. */
export function isSimulatedMessage(id?: string | null): boolean {
  return Boolean(id?.startsWith("dryrun-") || id?.startsWith("demo-"));
}

/** Use o endereço que o WhatsApp devolve; nunca o deduza do número de telefone. */
export function recipientJid(results: { exists: boolean; jid: string }[]): string | null {
  const recipient = results.find((r) => r.exists && /^[0-9]+@(s\.whatsapp\.net|lid)$/.test(r.jid));
  return recipient?.jid ?? null;
}

/** Telefone em E.164 com "+" — o formato aceito pelo gateway. */
export function isE164(value: string): boolean {
  return /^\+\d{10,15}$/.test(value);
}
