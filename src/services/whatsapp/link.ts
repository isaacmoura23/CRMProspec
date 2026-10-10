import "server-only";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId } from "@/services/agents/repository";
import { whatsappGatewayConfig } from "@/services/whatsapp/config";
import type { SessionStatusEvent } from "@/lib/gateway-events";
import type { WhatsappLink } from "@/types/agents";

/**
 * Estado da conexão do WhatsApp como o CRM o conhece, alimentado pelos eventos
 * `session.status` do gateway. Um registro por sessão.
 */

export async function getWhatsappLink(): Promise<WhatsappLink | null> {
  const cfg = whatsappGatewayConfig();
  if (!cfg) return null;
  return agentRepo().get("whatsapp_link", cfg.sessionId);
}

const STATUS_LABEL: Record<WhatsappLink["status"], string> = {
  DISCONNECTED: "desconectado",
  QR: "aguardando a leitura do QR Code",
  CONNECTING: "conectando",
  CONNECTED: "conectado",
  NEEDS_RECONNECT: "precisa reconectar (ler o QR Code de novo)",
};

/**
 * Aplica um evento de estado. Eventos fora de ordem (o gateway reenvia o que o
 * CRM não confirmou) não podem desfazer um estado mais novo: vale o instante em
 * que a mudança aconteceu, não o de chegada.
 */
export async function applySessionStatus(event: SessionStatusEvent): Promise<"applied" | "stale"> {
  const repo = agentRepo();
  const current = await repo.get("whatsapp_link", event.session_id);
  if (current && current.last_event_at > event.occurred_at) return "stale";
  // O repositório local devolve o próprio objeto guardado: o estado anterior
  // precisa ser lido antes do upsert, que o altera no lugar.
  const previousStatus = current?.status ?? null;

  const next: WhatsappLink = {
    id: event.session_id,
    organization_id: orgId(),
    status: event.data.status,
    phone: event.data.phone,
    push_name: event.data.push_name,
    last_error: event.data.last_error,
    dry_run: event.data.dry_run,
    last_event_at: event.occurred_at,
    updated_at: new Date().toISOString(),
  };
  await repo.upsert("whatsapp_link", next);

  // Só mudanças de estado entram no log (o gateway já não emite o que não mudou).
  if (previousStatus !== next.status) {
    const level = next.status === "NEEDS_RECONNECT" ? "warn" : "info";
    await logAgentEvent("sistema", level, "whatsapp.status", `WhatsApp ${STATUS_LABEL[next.status]}${next.phone ? ` (${next.phone})` : ""}.`);
  }
  return "applied";
}
