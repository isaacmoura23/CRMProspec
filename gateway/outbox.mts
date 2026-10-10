import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signGatewayEvent } from "../src/lib/gateway-signature";
import type { GatewayStore } from "./store.mjs";

/**
 * Entrega da caixa de saída ao CRM.
 *
 * Os eventos são gravados antes de qualquer tentativa de envio (ver
 * `GatewayStore.enqueue`), então um CRM fora do ar, um reinício do gateway ou
 * um erro de rede não perdem nada: o evento espera e sai na próxima tentativa.
 *
 * A ordem é preservada (FIFO estrito): se o primeiro evento não saiu, os
 * seguintes esperam — uma resposta de lead não ultrapassa o estado da sessão
 * que a explica.
 *
 * Duplicatas são inofensivas: o CRM deduplica pelo id do evento.
 */

export const MAX_BACKOFF_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 2_000;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts, 10));
}

export interface TickReport {
  delivered: number;
  retried: number;
  dead: number;
}

export interface DispatcherOptions {
  store: GatewayStore;
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Códigos em que reenviar o mesmo corpo não adianta: o CRM entendeu o evento e
 * o recusou como inválido. Ficam como "mortos" (guardados, sem bloquear a fila).
 * 401/403 NÃO entram: são segredo ou relógio errados, e quem corrige a
 * configuração quer que o que ficou retido saia.
 */
function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 425, 429].includes(status);
}

export class OutboxDispatcher {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: DispatcherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  start(intervalMs = 2_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma passada. Nunca se sobrepõe a outra e nunca lança. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { delivered: 0, retried: 0, dead: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const { store } = this.opts;
      for (const row of store.pending(20)) {
        // FIFO: o primeiro que ainda não venceu segura todos os de trás.
        if (row.next_attempt_at > this.now()) break;

        const outcome = await this.deliver(row.payload, row.event_id);
        if (outcome.kind === "ok") {
          store.markDelivered(row.id);
          report.delivered += 1;
        } else if (outcome.kind === "dead") {
          store.markDead(row.id, outcome.reason);
          this.opts.log?.("evento recusado pelo CRM, descartado da fila", { eventId: row.event_id, reason: outcome.reason });
          report.dead += 1;
        } else {
          store.markRetry(row.id, this.now() + backoffMs(row.attempts + 1), outcome.reason);
          report.retried += 1;
          break;
        }
      }
      store.purge(this.now());
    } catch (err) {
      this.opts.log?.("falha na entrega da caixa de saída", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
    return report;
  }

  private async deliver(
    payload: string,
    eventId: string
  ): Promise<{ kind: "ok" } | { kind: "retry"; reason: string } | { kind: "dead"; reason: string }> {
    const timestamp = this.now();
    try {
      const res = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [EVENT_ID_HEADER]: eventId,
          [TIMESTAMP_HEADER]: String(timestamp),
          [SIGNATURE_HEADER]: signGatewayEvent(this.opts.secret, timestamp, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (res.ok) return { kind: "ok" };
      const reason = `CRM respondeu ${res.status}`;
      return isPermanentRejection(res.status) ? { kind: "dead", reason } : { kind: "retry", reason };
    } catch (err) {
      return { kind: "retry", reason: `CRM inacessível: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
