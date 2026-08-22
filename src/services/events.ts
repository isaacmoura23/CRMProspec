import "server-only";
import { after } from "next/server";
import { getDb, saveDb } from "@/lib/store";
import { runAutomations } from "@/services/automations";
import { dispatchWebhooks } from "@/services/webhooks";
import { daysSince } from "@/lib/format";
import type { EventType } from "@/services/event-catalog";
import type { Lead } from "@/types";

/**
 * Barramento de eventos de domínio.
 *
 * Um único ponto de emissão alimenta os dois consumidores: o motor de
 * automações (síncrono, porque muda dados que a resposta já vai renderizar)
 * e a entrega de webhooks (assíncrona, porque é rede externa e não pode
 * atrasar a ação do usuário).
 */

interface EmitOptions {
  /** Eventos gerados por uma automação não reentram no motor — evita laço. */
  fromAutomation?: boolean;
  /** Dados extras enviados no corpo do webhook. */
  payload?: Record<string, unknown>;
}

/** Recorte do lead enviado ao webhook — sem campos internos de controle. */
function leadPayload(lead: Lead) {
  return {
    id: lead.id,
    company_name: lead.company_name,
    contact_name: lead.contact_name,
    segment: lead.segment,
    city: lead.city,
    state: lead.state,
    country: lead.country,
    phone: lead.phone,
    whatsapp: lead.whatsapp,
    email: lead.email,
    website: lead.website,
    instagram: lead.instagram,
    status: lead.status,
    lead_score: lead.lead_score,
    temperature: lead.temperature,
    potential_value: lead.potential_value,
    assigned_to: lead.assigned_to,
    source: lead.source,
    created_at: lead.created_at,
  };
}

/**
 * Agenda trabalho para depois da resposta HTTP.
 *
 * `after()` só vale dentro de um escopo de request; no job de prospecção já
 * estamos dentro de um, e aninhar lança. O fallback executa direto, sem
 * bloquear quem emitiu.
 */
function runAfterResponse(fn: () => Promise<void>) {
  try {
    after(() => fn().catch((err) => console.error("[events] tarefa pós-resposta falhou:", err)));
  } catch {
    void fn().catch((err) => console.error("[events] tarefa pós-resposta falhou:", err));
  }
}

export function emitEvent(event: EventType, lead: Lead | null, options: EmitOptions = {}): void {
  const derived: Array<{ type: EventType; payload?: Record<string, unknown> }> = [];

  try {
    if (!options.fromAutomation) {
      const outcomes = runAutomations(event, lead);
      if (outcomes.length > 0) {
        saveDb();
        for (const outcome of outcomes) derived.push(...outcome.events);
      }
    }
  } catch (err) {
    console.error(`[events] automações do evento "${event}" falharam:`, err);
  }

  const payload = {
    ...(lead ? { lead: leadPayload(lead) } : {}),
    ...(options.payload ?? {}),
  };
  runAfterResponse(() => dispatchWebhooks(event, payload));

  // O que a automação causou também é evento para quem escuta de fora, mas
  // com `fromAutomation` para não reentrar no motor e virar laço.
  for (const d of derived) {
    emitEvent(d.type, lead, { fromAutomation: true, payload: d.payload });
  }
}

/* ------------------------------------------------------------------ */
/* Gatilho por tempo                                                   */
/* ------------------------------------------------------------------ */

const STALE_DAYS = 5;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type GlobalWithSweep = typeof globalThis & { __crmLastStaleSweep?: number };

/**
 * "Lead sem contato há N dias" não tem um momento em que acontece — só
 * passa a ser verdade. Sem um agendador, a varredura roda no máximo a cada
 * cinco minutos, disparada pela navegação, e marca cada lead uma única vez
 * (a tarefa de follow-up criada pela automação serve de trava).
 */
export function sweepStaleLeads(): void {
  const g = globalThis as GlobalWithSweep;
  const now = Date.now();
  if (g.__crmLastStaleSweep && now - g.__crmLastStaleSweep < SWEEP_INTERVAL_MS) return;
  g.__crmLastStaleSweep = now;

  const db = getDb();
  const hasStaleRule = db.automation_rules.some(
    (r) => r.active && (r.trigger === "lead.stale" || r.trigger === "Lead sem contato há 5 dias")
  );
  const hasStaleHook = db.webhooks.some((w) => w.active && w.events.includes("lead.stale"));
  if (!hasStaleRule && !hasStaleHook) return;

  const stale = db.leads.filter(
    (l) =>
      !l.archived &&
      !["fechado", "perdido"].includes(l.status) &&
      l.last_contact_at !== null &&
      daysSince(l.last_contact_at) >= STALE_DAYS &&
      !l.next_follow_up_at
  );

  for (const lead of stale.slice(0, 25)) {
    emitEvent("lead.stale", lead);
  }
}
