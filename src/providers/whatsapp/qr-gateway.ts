import { ProviderError, type ProviderErrorKind, type SendResult, type SendTextInput, type WhatsAppProvider } from "@/providers/whatsapp/types";
import type { SessionStatus } from "@/lib/gateway-events";

/**
 * Cliente HTTP do gateway de WhatsApp (gateway/index.mts). Portado do
 * `QrGatewayWhatsAppProvider` da Cobra.
 *
 * Biblioteca não oficial (Baileys), não a API da Meta: sem modelos aprovados e
 * sem janela de 24 h, mas sujeita às regras de uso do WhatsApp.
 */

export interface GatewayStatus {
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  qrDataUrl: string | null;
  qrUpdatedAt: string | null;
  lastError: string | null;
  /** Gateway em modo de teste: nada é enviado de verdade. */
  dryRun: boolean;
}

export interface GatewayHealth {
  ok: boolean;
  dryRun: boolean;
  sessions: Array<{ id: string; status: SessionStatus }>;
  outbox: { pending: number; dead: number };
}

/** Consultas de tela não podem pendurar a página: o gateway local responde em milissegundos. */
const QUICK_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 20_000;

export class QrGatewayWhatsAppProvider implements WhatsAppProvider {
  readonly name = "qr_gateway";

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly sessionId: string
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = QUICK_TIMEOUT_MS, scoped = true): Promise<T> {
    const base = this.baseUrl.replace(/\/$/, "");
    const url = scoped ? `${base}/sessions/${this.sessionId}${path}` : `${base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
        throw new ProviderError("TIMEOUT", "O gateway do WhatsApp não respondeu a tempo.");
      }
      throw new ProviderError("TEMPORARY", `Gateway do WhatsApp inacessível: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; kind?: string } & T;
    if (!res.ok) {
      const kind = (json.kind as ProviderErrorKind | undefined) ?? (res.status === 401 ? "AUTH" : res.status >= 500 ? "TEMPORARY" : "PERMANENT");
      throw new ProviderError(kind, json.error ?? `Erro HTTP ${res.status} no gateway`, res.status);
    }
    return json;
  }

  status(): Promise<GatewayStatus> {
    return this.request<GatewayStatus>("/status", { method: "GET" });
  }

  /** O gateway espera o QR aparecer antes de responder: dê folga ao tempo limite. */
  connect(): Promise<GatewayStatus> {
    return this.request<GatewayStatus>("/connect", { method: "POST" }, 15_000);
  }

  /** `logout: false` só fecha o socket e guarda a sessão; `true` apaga a sessão (novo QR para voltar). */
  disconnect(logout: boolean): Promise<GatewayStatus> {
    return this.request<GatewayStatus>(logout ? "/logout" : "/disconnect", { method: "POST" });
  }

  health(): Promise<GatewayHealth> {
    return this.request<GatewayHealth>("/health", { method: "GET" }, QUICK_TIMEOUT_MS, false);
  }

  /** O número tem WhatsApp? Consulta ao WhatsApp, não envia nada. */
  recipient(to: string): Promise<{ exists: boolean; jid: string | null }> {
    return this.request("/recipient", { method: "POST", body: JSON.stringify({ to }) });
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const r = await this.request<{ providerMessageId: string; dryRun?: boolean }>(
      "/messages",
      { method: "POST", body: JSON.stringify({ to: input.to, text: input.body, clientReference: input.clientReference }) },
      SEND_TIMEOUT_MS
    );
    if (r.dryRun || r.providerMessageId?.startsWith("dryrun-")) {
      // Modo de teste: nada saiu. Não é falha do envio nem do número — a
      // mensagem espera na fila até os envios reais serem ativados.
      throw new ProviderError("DRY_RUN", "Gateway em modo de teste: a mensagem não foi enviada.");
    }
    return { providerMessageId: r.providerMessageId };
  }
}
