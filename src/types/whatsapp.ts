import type { SessionStatus } from "@/lib/gateway-events";

/** O que a tela de conexão do WhatsApp precisa saber, já resolvido no servidor. */
export interface WhatsappPanelState {
  /** Há URL e token do gateway no ambiente do CRM. */
  configured: boolean;
  /** Há segredo para validar os eventos que o gateway entrega. */
  webhookConfigured: boolean;
  /** O gateway respondeu agora. */
  reachable: boolean;
  /** Por que não respondeu, em linguagem de gente. */
  error: string | null;
  /** Estado ao vivo, direto do gateway. O QR só vem para quem pode conectar. */
  status: {
    status: SessionStatus;
    phone: string | null;
    pushName: string | null;
    qrDataUrl: string | null;
    qrUpdatedAt: string | null;
    lastError: string | null;
    dryRun: boolean;
    sendMode: "simulado" | "restrito" | "real";
    allowedCount: number;
  } | null;
  /** Eventos esperando para chegar ao CRM (e os que o CRM recusou). */
  outbox: { pending: number; dead: number } | null;
  /** O que o CRM sabe pelos webhooks: serve para detectar webhook quebrado. */
  link: { status: SessionStatus; phone: string | null; lastEventAt: string; dryRun: boolean } | null;
}

export type WhatsappActionResult = { ok: true; state: WhatsappPanelState; message?: string } | { ok: false; error: string };
