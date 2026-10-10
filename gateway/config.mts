import path from "node:path";

export interface GatewayConfig {
  port: number;
  /** Só local por padrão: o gateway nunca deve ficar exposto sem HTTPS na frente. */
  host: string;
  token: string;
  /** Para onde entregar os eventos. Sem isto, eles ficam retidos na caixa de saída. */
  webhookUrl: string | null;
  webhookSecret: string | null;
  /** Modo de teste: aceita envios, registra e NÃO manda nada pelo WhatsApp. */
  dryRun: boolean;
  dbFile: string;
  /** Entrega mensagens recebidas ao CRM (a fase do Vendedor liga isto). */
  forwardMessages: boolean;
  /** Quanto esperar a leitura do QR antes de desistir. */
  qrWaitMaxMs: number;
}

const truthy = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const falsy = (v: string | undefined) => v === "0" || v?.toLowerCase() === "false";

/**
 * Lê e valida a configuração. Falha alto, em português, antes de abrir
 * qualquer conexão: um gateway meio configurado é pior que um que não sobe.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const token = env.WHATSAPP_GATEWAY_TOKEN ?? "";
  if (token.length < 16) {
    throw new Error("Defina WHATSAPP_GATEWAY_TOKEN com ao menos 16 caracteres (node scripts/set-whatsapp-gateway.mjs gera um).");
  }

  const webhookUrl = env.CRM_WEBHOOK_URL?.trim() || null;
  const webhookSecret = env.WHATSAPP_WEBHOOK_SECRET?.trim() || null;
  if (webhookUrl) {
    if (!/^https?:\/\//i.test(webhookUrl)) throw new Error("CRM_WEBHOOK_URL precisa começar com http:// ou https://.");
    if (!webhookSecret || webhookSecret.length < 16) {
      throw new Error("Com CRM_WEBHOOK_URL definida, WHATSAPP_WEBHOOK_SECRET precisa ter ao menos 16 caracteres: os eventos são assinados.");
    }
  }

  const port = Number(env.GATEWAY_PORT ?? 3200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GATEWAY_PORT inválida.");

  return {
    port,
    host: env.GATEWAY_HOST?.trim() || "127.0.0.1",
    token,
    webhookUrl,
    webhookSecret,
    // Seguro por padrão: só envia de verdade quem desligar o modo de teste de propósito.
    dryRun: !falsy(env.WHATSAPP_GATEWAY_DRY_RUN),
    dbFile: path.resolve(env.GATEWAY_DB_FILE?.trim() || path.join("gateway", ".data", "gateway.db")),
    forwardMessages: truthy(env.GATEWAY_FORWARD_MESSAGES),
    qrWaitMaxMs: Math.max(30_000, Number(env.GATEWAY_QR_WAIT_MAX_MS ?? 5 * 60_000)),
  };
}
