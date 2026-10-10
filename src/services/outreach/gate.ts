import "server-only";
import type { SellerConfig } from "@/agents/config";
import { dailyCap, gapSeconds, localParts, nextWindowOpen, SP_TZ, type SendWindow } from "@/lib/outreach-policy";
import { agentRepo } from "@/services/agents/repository";
import type { OutreachMessage } from "@/types/agents";

/**
 * Portão global do envio: janela, teto diário com aquecimento e intervalo.
 *
 * Tudo aqui é **global** (vale para o número, não para um lead): quando bloqueia,
 * bloqueia a fila inteira até o instante devolvido.
 */

export function windowOf(cfg: SellerConfig): SendWindow {
  return { days: cfg.send_days, startHour: cfg.start_hour, endHour: cfg.end_hour, tz: SP_TZ };
}

/** Mensagem que pesa no teto: saiu, ou saiu e não se sabe se chegou. */
function countsAsSent(m: OutreachMessage): boolean {
  return m.status === "SENT" || m.status === "DELIVERED" || m.status === "READ" || m.status === "UNCERTAIN";
}

/** Quando o envio "aconteceu" (incerto não tem sent_at: vale o instante do registro). */
function sentAt(m: OutreachMessage): string {
  return m.sent_at ?? m.created_at;
}

/** Primeiro instante do próximo dia civil em São Paulo. */
function nextLocalDay(now: Date): Date {
  const today = localParts(now).day;
  let t = now.getTime();
  // Passos de 30 min: no máximo 48 iterações, sem aritmética de fuso à mão.
  for (let i = 0; i < 60 && localParts(new Date(t)).day === today; i++) t += 30 * 60_000;
  return new Date(t);
}

export interface OutreachStats {
  sentToday: number;
  cap: number;
  /** Instante a partir do qual o intervalo mínimo entre envios já passou. */
  nextAllowedAt: Date | null;
  firstSendAt: Date | null;
}

export async function outreachStats(now: Date, cfg: SellerConfig): Promise<OutreachStats> {
  const repo = agentRepo();
  const [recent, earliest] = await Promise.all([
    repo.list("outreach_messages", { orderBy: "created_at", desc: true, limit: 1000 }),
    repo.list("outreach_messages", { orderBy: "sent_at", limit: 1 }),
  ]);

  const today = localParts(now).day;
  const sentToday = recent.filter((m) => countsAsSent(m) && localParts(new Date(sentAt(m))).day === today).length;

  const first = earliest[0]?.sent_at ? new Date(earliest[0].sent_at) : null;
  const daysSince = first ? (now.getTime() - first.getTime()) / 86_400_000 : null;
  const cap = dailyCap(daysSince, cfg.daily_cap_max, cfg.warmup);

  const last = recent.filter(countsAsSent).sort((a, b) => sentAt(b).localeCompare(sentAt(a)))[0];
  const nextAllowedAt = last
    ? new Date(Date.parse(sentAt(last)) + gapSeconds(last.id, cfg.min_gap_seconds, cfg.max_gap_seconds) * 1000)
    : null;

  return { sentToday, cap, nextAllowedAt, firstSendAt: first };
}

export type GateResult = { ok: true } | { ok: false; reason: "cap" | "gap"; until: Date };

/** Pode sair mais uma mensagem agora? */
export async function sendGate(now: Date, cfg: SellerConfig): Promise<GateResult> {
  const stats = await outreachStats(now, cfg);

  if (stats.sentToday >= stats.cap) {
    // Teto do dia esgotado: só amanhã, e dentro da janela.
    const open = nextWindowOpen(nextLocalDay(now), windowOf(cfg));
    return { ok: false, reason: "cap", until: open ?? nextLocalDay(now) };
  }
  if (stats.nextAllowedAt && stats.nextAllowedAt.getTime() > now.getTime()) {
    return { ok: false, reason: "gap", until: stats.nextAllowedAt };
  }
  return { ok: true };
}
