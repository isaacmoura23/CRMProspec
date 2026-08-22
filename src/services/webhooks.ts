import "server-only";
import crypto from "node:crypto";
import { getDb, nowIso, saveDb } from "@/lib/store";
import type { EventType } from "@/services/event-catalog";
import type { Webhook } from "@/types";

/**
 * Entrega de webhooks.
 *
 * Cada assinante recebe um POST assinado com HMAC SHA-256 no cabeçalho
 * `X-ProspecAtlas-Signature`, para o destinatário conseguir verificar que a
 * chamada partiu daqui. O resultado da entrega fica gravado no próprio
 * webhook e é o que a tela de integrações mostra.
 */

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;
/** Após esse tanto de falhas seguidas o webhook é desativado. */
const FAILURE_LIMIT = 10;

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}

export function signPayload(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function recordResult(
  webhookId: string,
  result: { status: number | null; error: string | null }
) {
  const db = getDb();
  const hook = db.webhooks.find((w) => w.id === webhookId);
  if (!hook) return;
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  hook.last_status = result.status;
  hook.last_error = ok ? null : result.error;
  hook.last_delivery_at = nowIso();
  hook.consecutive_failures = ok ? 0 : (hook.consecutive_failures ?? 0) + 1;
  if ((hook.consecutive_failures ?? 0) >= FAILURE_LIMIT) {
    hook.active = false;
    hook.last_error = `Desativado após ${FAILURE_LIMIT} falhas seguidas. ${result.error ?? ""}`.trim();
  }
  saveDb();
}

async function deliver(hook: Webhook, body: string, signature: string | null): Promise<void> {
  let lastError = "Falha desconhecida";
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ProspecAtlas-Webhook/1",
          ...(signature ? { "X-ProspecAtlas-Signature": `sha256=${signature}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      lastStatus = res.status;
      if (res.ok) {
        recordResult(hook.id, { status: res.status, error: null });
        return;
      }
      lastError = `HTTP ${res.status}`;
      // 4xx não melhora com retry — só 5xx e erro de rede.
      if (res.status < 500) break;
    } catch (err) {
      lastStatus = null;
      lastError = err instanceof Error ? err.message : "Erro de rede";
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500));
  }

  recordResult(hook.id, { status: lastStatus, error: lastError });
}

/**
 * Dispara o evento para todos os webhooks ativos inscritos nele.
 *
 * Não lança: uma URL fora do ar não pode derrubar a ação do usuário que
 * originou o evento.
 */
export async function dispatchWebhooks(
  event: EventType,
  payload: Record<string, unknown>
): Promise<void> {
  const db = getDb();
  const subscribers = db.webhooks.filter((w) => w.active && w.events.includes(event));
  if (subscribers.length === 0) return;

  const body = JSON.stringify({
    event,
    organization_id: db.organization.id,
    delivered_at: nowIso(),
    data: payload,
  });

  await Promise.all(
    subscribers.map((hook) =>
      deliver(hook, body, hook.secret ? signPayload(hook.secret, body) : null).catch((err) => {
        console.error("[webhooks] entrega falhou:", err);
      })
    )
  );
}

/**
 * Entrega de teste, disparada pela tela de integrações. Diferente do fluxo
 * normal, é aguardada: o usuário está esperando o resultado.
 */
export async function deliverTestEvent(hook: Webhook): Promise<void> {
  const db = getDb();
  const body = JSON.stringify({
    event: "ping",
    organization_id: db.organization.id,
    delivered_at: nowIso(),
    data: { message: "Entrega de teste do ProspecAtlas." },
  });
  await deliver(hook, body, hook.secret ? signPayload(hook.secret, body) : null);
}
