import "server-only";
import { registerAgentHandlers } from "@/agents/registry";
import { uid } from "@/lib/utils";
import { logAgentEvent } from "@/services/agents/log";
import { planAgents } from "@/services/agents/planner";
import { runAgentQueue } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import { runnableAgents } from "@/services/agents/settings";

/**
 * Runner dos agentes: um laço dentro do processo do servidor.
 *
 * A cada poucos segundos, planeja o que os agentes querem iniciar (de tempos
 * em tempos) e executa o que está vencido na fila. Grava um batimento para a
 * tela mostrar se ele está vivo. Reiniciar o servidor só atrasa as tarefas:
 * quem estava no meio tem o lease vencido e é retomado.
 *
 * Não roda na Vercel (funções serverless não mantêm laço) nem com
 * `AGENTS_RUNNER=off`.
 */

const TICK_MS = 5_000;
const BEAT_MS = 10_000;
const PLAN_EVERY_MS = 60_000;
const HOUSEKEEPING_EVERY_MS = 60 * 60_000;
const INITIAL_DELAY_MS = 3_000;

const EVENT_RETENTION_DAYS = 14;
const APPROVAL_RETENTION_DAYS = 30;
const SPEND_RETENTION_DAYS = 60;
const HEARTBEAT_RETENTION_DAYS = 1;
const RECEIPT_RETENTION_DAYS = 7;

interface RunnerState {
  instance: string;
  startedAt: string;
  tickTimer: ReturnType<typeof setInterval> | null;
  beatTimer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastPlanAt: number;
  lastHousekeepingAt: number;
}

type GlobalWithRunner = typeof globalThis & { __agentRunner?: RunnerState };

function state(): RunnerState | undefined {
  return (globalThis as GlobalWithRunner).__agentRunner;
}

export function runnerInstanceId(): string | null {
  return state()?.instance ?? null;
}

export function startAgentRunner(): { started: true } | { started: false; reason: string } {
  const g = globalThis as GlobalWithRunner;
  if (g.__agentRunner) return { started: false, reason: "já está rodando neste processo" };
  if (process.env.VERCEL) return { started: false, reason: "ambiente serverless (Vercel)" };
  if (process.env.AGENTS_RUNNER === "off") return { started: false, reason: "AGENTS_RUNNER=off" };
  if (process.env.NODE_ENV === "test") return { started: false, reason: "ambiente de teste" };

  registerAgentHandlers();

  const s: RunnerState = {
    instance: `runner_${process.pid}_${uid()}`,
    startedAt: new Date().toISOString(),
    tickTimer: null,
    beatTimer: null,
    ticking: false,
    lastPlanAt: 0,
    lastHousekeepingAt: 0,
  };
  g.__agentRunner = s;

  s.beatTimer = setInterval(() => void beat(s), BEAT_MS);
  s.tickTimer = setInterval(() => void runnerTick(s), TICK_MS);
  s.beatTimer.unref?.();
  s.tickTimer.unref?.();
  setTimeout(() => {
    void beat(s);
    void runnerTick(s);
  }, INITIAL_DELAY_MS).unref?.();

  void logAgentEvent("sistema", "info", "runner.started", `Runner iniciado (${s.instance}).`);
  return { started: true };
}

export function stopAgentRunner() {
  const g = globalThis as GlobalWithRunner;
  const s = g.__agentRunner;
  if (!s) return;
  if (s.tickTimer) clearInterval(s.tickTimer);
  if (s.beatTimer) clearInterval(s.beatTimer);
  delete g.__agentRunner;
}

async function beat(s: RunnerState) {
  try {
    await agentRepo().upsert("heartbeats", {
      id: s.instance,
      organization_id: orgId(),
      instance: s.instance,
      started_at: s.startedAt,
      beat_at: new Date().toISOString(),
      info: { pid: process.pid, platform: process.platform },
    });
  } catch (err) {
    console.error("[agentes] falha ao gravar batimento:", err);
  }
}

/** Uma passada: planeja (a cada minuto), executa o que está vencido, faz a limpeza (a cada hora). */
export async function runnerTick(s: Pick<RunnerState, "ticking" | "lastPlanAt" | "lastHousekeepingAt"> = state()!): Promise<void> {
  if (!s || s.ticking) return;
  s.ticking = true;
  try {
    const now = Date.now();
    if (now - s.lastPlanAt >= PLAN_EVERY_MS) {
      s.lastPlanAt = now;
      await planAgents();
    }

    const agents = await runnableAgents();
    if (agents.length > 0) await runAgentQueue({ agents });

    if (now - s.lastHousekeepingAt >= HOUSEKEEPING_EVERY_MS) {
      s.lastHousekeepingAt = now;
      await housekeeping(now);
    }
  } catch (err) {
    console.error("[agentes] falha no ciclo do runner:", err);
  } finally {
    s.ticking = false;
  }
}

const daysAgo = (now: number, days: number) => new Date(now - days * 86_400_000).toISOString();

/** O log não pode crescer sem fim, nem no snapshot nem no banco. */
export async function housekeeping(now = Date.now()): Promise<void> {
  const repo = agentRepo();
  await repo.removeOlderThan("events", "created_at", daysAgo(now, EVENT_RETENTION_DAYS));
  await repo.removeOlderThan("spend", "created_at", daysAgo(now, SPEND_RETENTION_DAYS));
  await repo.removeOlderThan("heartbeats", "beat_at", daysAgo(now, HEARTBEAT_RETENTION_DAYS));
  // Recibos de webhook: só precisam durar mais que a janela de reenvio do gateway.
  await repo.removeOlderThan("whatsapp_receipts", "received_at", daysAgo(now, RECEIPT_RETENTION_DAYS));
  const old = (await repo.list("approvals")).filter(
    (a) => a.status !== "pendente" && a.created_at < daysAgo(now, APPROVAL_RETENTION_DAYS)
  );
  for (const a of old) await repo.remove("approvals", { id: a.id });
}
