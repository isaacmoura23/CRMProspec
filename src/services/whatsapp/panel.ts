import "server-only";
import { ProviderError } from "@/providers/whatsapp/types";
import { getWhatsappLink } from "@/services/whatsapp/link";
import { whatsappGateway, whatsappGatewayConfig, whatsappWebhookSecret } from "@/services/whatsapp/config";
import type { WhatsappPanelState } from "@/types/whatsapp";

/** Tradução de erro do gateway para algo que o usuário sabe resolver. */
export function describeGatewayError(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.kind === "TEMPORARY" || err.kind === "TIMEOUT") {
      return "O gateway do WhatsApp não responde. Ele é um processo à parte: inicie-o com `npm run gateway` no seu computador.";
    }
    if (err.kind === "AUTH") {
      return "O gateway recusou o token. Confira se WHATSAPP_GATEWAY_TOKEN é o mesmo no CRM (.env.local) e no gateway (.env.gateway).";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Falha inesperada ao falar com o gateway.";
}

/**
 * Estado completo da tela de conexão. `includeQr` só para quem pode conectar:
 * ler o QR vincula o WhatsApp da empresa, e isso não é para qualquer perfil.
 */
export async function loadWhatsappPanelState(opts: { includeQr: boolean }): Promise<WhatsappPanelState> {
  const cfg = whatsappGatewayConfig();
  const webhookConfigured = whatsappWebhookSecret() !== null;
  if (!cfg) {
    return { configured: false, webhookConfigured, reachable: false, error: null, status: null, outbox: null, link: null };
  }

  const link = await getWhatsappLink();
  const linkSummary = link ? { status: link.status, phone: link.phone, lastEventAt: link.last_event_at, dryRun: link.dry_run } : null;

  const gateway = whatsappGateway()!;
  try {
    const [status, health] = await Promise.all([gateway.status(), gateway.health().catch(() => null)]);
    return {
      configured: true,
      webhookConfigured,
      reachable: true,
      error: null,
      status: {
        status: status.status,
        phone: status.phone,
        pushName: status.pushName,
        qrDataUrl: opts.includeQr ? status.qrDataUrl : null,
        qrUpdatedAt: status.qrUpdatedAt,
        lastError: status.lastError,
        dryRun: status.dryRun,
      },
      outbox: health?.outbox ?? null,
      link: linkSummary,
    };
  } catch (err) {
    return { configured: true, webhookConfigured, reachable: false, error: describeGatewayError(err), status: null, outbox: null, link: linkSummary };
  }
}
