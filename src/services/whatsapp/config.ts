import "server-only";
import { QrGatewayWhatsAppProvider } from "@/providers/whatsapp/qr-gateway";
import { getDb } from "@/lib/store";

/**
 * Configuração do gateway de WhatsApp no lado do CRM.
 *
 *   WHATSAPP_GATEWAY_URL      onde o gateway escuta (ex.: http://127.0.0.1:3200)
 *   WHATSAPP_GATEWAY_TOKEN    token compartilhado (Authorization: Bearer)
 *   WHATSAPP_WEBHOOK_SECRET   segredo que assina os eventos que o gateway entrega
 *   WHATSAPP_SESSION_ID       opcional; padrão = id da organização
 *
 * Sem URL e token o recurso simplesmente não existe: nada de aviso, banner nem
 * tela quebrada para quem não usa WhatsApp. `node scripts/set-whatsapp-gateway.mjs`
 * gera os três valores, sem mostrá-los.
 */

export interface WhatsappGatewayConfig {
  url: string;
  token: string;
  sessionId: string;
}

/** O gateway só aceita ids no formato [A-Za-z0-9_-]{1,64}. */
export function sanitizeSessionId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "atlas";
}

export function whatsappGatewayConfig(): WhatsappGatewayConfig | null {
  const url = process.env.WHATSAPP_GATEWAY_URL?.trim();
  const token = process.env.WHATSAPP_GATEWAY_TOKEN?.trim();
  if (!url || !token) return null;
  return {
    url,
    token,
    sessionId: sanitizeSessionId(process.env.WHATSAPP_SESSION_ID?.trim() || getDb().organization.id),
  };
}

export function isWhatsappGatewayConfigured(): boolean {
  return whatsappGatewayConfig() !== null;
}

/** Segredo de assinatura dos webhooks; ausente ou curto = o webhook recusa tudo. */
export function whatsappWebhookSecret(): string | null {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

export function whatsappGateway(): QrGatewayWhatsAppProvider | null {
  const cfg = whatsappGatewayConfig();
  return cfg ? new QrGatewayWhatsAppProvider(cfg.url, cfg.token, cfg.sessionId, whatsappWebhookSecret()) : null;
}
