/**
 * Contrato do canal de WhatsApp. Portado do `WhatsAppProvider` da Cobra
 * (agenteitalo), reduzido ao que o CRM usa: texto por gateway de QR Code. Um
 * provedor oficial (Cloud API da Meta) entra implementando a mesma interface.
 */

export type ProviderErrorKind =
  | "RATE_LIMITED" // aguardar e tentar de novo
  | "TEMPORARY" // falha transitória (5xx, rede)
  | "TIMEOUT" // sem confirmação: resultado incerto — NUNCA reenviar sozinho
  | "INVALID_RECIPIENT" // número inválido / sem WhatsApp
  | "AUTH" // token do gateway inválido
  | "DISCONNECTED" // sessão desconectada: preservar a fila, não contar tentativa
  | "DRY_RUN" // gateway em modo de teste: nada saiu; preservar a fila como no desconectado
  | "PERMANENT"; // outro erro definitivo

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly providerCode?: string | number
  ) {
    super(message);
    this.name = "ProviderError";
  }
  /** Tentativas técnicas só fazem sentido para erros transitórios. */
  get retryable(): boolean {
    return this.kind === "RATE_LIMITED" || this.kind === "TEMPORARY";
  }
  /** Sem confirmação do provedor: registrar como incerto; reenviar pode duplicar. */
  get uncertain(): boolean {
    return this.kind === "TIMEOUT";
  }
}

export interface SendTextInput {
  /** E.164 com "+" */
  to: string;
  body: string;
  /** Referência única do ciclo de envio (idempotência lógica nossa). */
  clientReference: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendText(input: SendTextInput): Promise<SendResult>;
}
