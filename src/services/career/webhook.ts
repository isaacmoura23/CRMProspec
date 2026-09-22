import "server-only";
import { careerRepo } from "@/services/career/repository";
import { appendEvent } from "@/services/career/service";
import type { EmailStatus } from "@/types/career";

/**
 * Processamento dos eventos do Resend (já com assinatura verificada).
 *
 * Eventos chegam duplicados e fora de ordem; cada `svix-id` é gravado como
 * recibo e ignorado na segunda vez, e o status de e-mail só avança
 * (aceito → enviado → entregue), exceto pelos terminais bounce/reclamação,
 * que prevalecem sempre. Entrega não prova leitura nem contratação — o
 * status de seleção é outro campo, independente.
 */

const RANK: Record<EmailStatus, number> = { aceito: 1, enviado: 2, atrasado: 3, entregue: 4, devolvido: 9, reclamacao: 9 };

const EVENT_MAP: Record<string, EmailStatus> = {
  "email.sent": "enviado",
  "email.delivered": "entregue",
  "email.delivery_delayed": "atrasado",
  "email.bounced": "devolvido",
  "email.complained": "reclamacao",
};

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; bounce?: { message?: string }; [k: string]: unknown };
}

export async function processResendEvent(svixId: string, event: ResendEvent): Promise<{ handled: boolean; reason: string }> {
  const repo = careerRepo();
  const receipts = await repo.findAny("webhook_receipts", { id: svixId });
  if (receipts.length > 0) return { handled: false, reason: "evento repetido" };
  await repo.insert("webhook_receipts", { id: svixId, provider: "resend", received_at: new Date().toISOString() });

  const status = EVENT_MAP[event.type];
  const emailId = event.data?.email_id;
  if (!status || !emailId) return { handled: false, reason: `evento ${event.type} ignorado` };

  const apps = await repo.findAny("applications", { provider_message_id: emailId });
  const app = apps[0];
  if (!app) return { handled: false, reason: "e-mail não pertence a uma candidatura" };

  const owner = { owner_id: app.owner_id, organization_id: app.organization_id };
  const occurredAt = event.created_at ? new Date(event.created_at).toISOString() : new Date().toISOString();
  const detail = event.type === "email.bounced" ? `Devolvido: ${event.data?.bounce?.message ?? "sem detalhe"}` : null;
  await appendEvent(owner, app.id, `email:${status}`, "webhook", detail, { provider_event_id: svixId, occurred_at: occurredAt });

  const current = app.email_status ? RANK[app.email_status] : 0;
  if (RANK[status] > current || RANK[status] === 9) {
    await repo.updateAny("applications", app.id, { email_status: status, updated_at: new Date().toISOString() });
  }
  // Devolução/reclamação interrompe tentativas futuras a esse destinatário.
  if (status === "devolvido" || status === "reclamacao") {
    await repo.updateAny("applications", app.id, { last_error: detail ?? "Destinatário recusou/reclamou", updated_at: new Date().toISOString() });
  }
  return { handled: true, reason: status };
}
