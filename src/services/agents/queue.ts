import "server-only";
import { uid } from "@/lib/utils";
import { RateLimitedError } from "@/providers/jobs/types";
import { backoffMs } from "@/services/career/queue";
import { logAgentEvent, recordSpend } from "@/services/agents/log";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import type { AgentEventLevel, AgentId, AgentTask, SpendKind } from "@/types/agents";

/**
 * Fila durável dos agentes.
 *
 * Derivada de `career/queue.ts` (lease, heartbeat, backoff com jitter, 429 sem
 * queimar tentativa), com três diferenças:
 *   - tarefas pertencem a um agente, e quem reivindica informa quais agentes
 *     estão liberados — assim um agente pausado deixa as tarefas intactas na
 *     fila em vez de consumi-las;
 *   - `dedupe_key` impede a mesma tarefa de ser enfileirada duas vezes;
 *   - uma tarefa cujo processo morreu no meio (lease vencido) conta tentativa,
 *     para não reprocessar para sempre algo que derruba o servidor.
 *
 * Nada depende de timers em memória para sobreviver: reiniciar o processo só
 * atrasa a tarefa até o próximo ciclo do runner.
 */

export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Erro sem conserto por tentativa nova (parâmetro inválido, recurso inexistente). */
export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentTaskError";
  }
}

export interface AgentTaskContext {
  task: AgentTask;
  /** Progresso visível na interface. */
  progress(done: number, total: number, label: string): Promise<void>;
  log(level: AgentEventLevel, message: string, data?: Record<string, unknown>): Promise<void>;
  /** Guarda o resumo que aparece no relatório da execução. */
  setResult(result: Record<string, unknown>): void;
  /** Reagenda a própria tarefa sem contar como falha (ex.: teto diário atingido). */
  reschedule(at: Date): void;
  /** Pedido de cancelamento feito pela interface enquanto a tarefa roda. */
  isCancelled(): Promise<boolean>;
  spend(kind: SpendKind, amount: number, note?: string): Promise<void>;
}

export type AgentTaskHandler = (ctx: AgentTaskContext) => Promise<void>;

type GlobalWithHandlers = typeof globalThis & {
  __agentHandlers?: Map<string, AgentTaskHandler>;
  __agentQueueRunning?: boolean;
};

/**
 * O registro mora em `globalThis`: o runner nasce em `instrumentation.ts` e as
 * actions em outro bundle do Next, e cada um teria o seu `Map` se ele fosse
 * uma variável de módulo.
 */
function handlers(): Map<string, AgentTaskHandler> {
  const g = globalThis as GlobalWithHandlers;
  g.__agentHandlers ??= new Map();
  return g.__agentHandlers;
}

export function registerAgentHandler(kind: string, handler: AgentTaskHandler) {
  handlers().set(kind, handler);
}

export function hasAgentHandler(kind: string): boolean {
  return handlers().has(kind);
}

export interface EnqueueInput {
  agent: AgentId;
  kind: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  createdBy?: string | null;
}

export async function enqueueAgentTask(input: EnqueueInput): Promise<{ task: AgentTask; created: boolean }> {
  const repo = agentRepo();
  const now = new Date().toISOString();
  const task: AgentTask = {
    id: uid("atk"),
    organization_id: orgId(),
    agent: input.agent,
    kind: input.kind,
    payload: input.payload ?? {},
    dedupe_key: input.dedupeKey ?? null,
    status: "pendente",
    attempts: 0,
    max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    next_run_at: (input.runAt ?? new Date()).toISOString(),
    locked_until: null,
    lock_owner: null,
    last_error: null,
    progress: null,
    result: null,
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };
  try {
    await repo.insert("tasks", task);
    return { task, created: true };
  } catch (err) {
    if (err instanceof UniqueViolationError && task.dedupe_key) {
      const existing = (await repo.list("tasks", { where: { dedupe_key: task.dedupe_key } })).find(
        (t) => t.status === "pendente" || t.status === "processando"
      );
      if (existing) return { task: existing, created: false };
    }
    throw err;
  }
}

export async function cancelAgentTask(taskId: string): Promise<AgentTask | null> {
  const repo = agentRepo();
  const task = await repo.get("tasks", taskId);
  if (!task || (task.status !== "pendente" && task.status !== "processando")) return null;
  const now = new Date().toISOString();
  return repo.update("tasks", taskId, {
    status: "cancelado",
    finished_at: now,
    updated_at: now,
    locked_until: null,
    lock_owner: null,
  });
}

export interface QueueReport {
  processed: number;
  failed: number;
  rescheduled: number;
  skipped: boolean;
}

export interface RunQueueOptions {
  /** Agentes liberados nesta passada. Lista vazia = nada roda. */
  agents: readonly AgentId[];
  budgetMs?: number;
  maxTasks?: number;
  lockOwner?: string;
}

export async function runAgentQueue(opts: RunQueueOptions): Promise<QueueReport> {
  const g = globalThis as GlobalWithHandlers;
  const report: QueueReport = { processed: 0, failed: 0, rescheduled: 0, skipped: false };
  // Uma passada por processo; outras instâncias disputam o lease no banco.
  if (g.__agentQueueRunning) {
    report.skipped = true;
    return report;
  }
  g.__agentQueueRunning = true;
  const deadline = Date.now() + (opts.budgetMs ?? 5 * 60_000);
  const maxTasks = opts.maxTasks ?? 25;
  const lockOwner = opts.lockOwner ?? `runner_${process.pid}_${uid()}`;
  const repo = agentRepo();

  try {
    while (Date.now() < deadline && report.processed + report.failed + report.rescheduled < maxTasks) {
      const claimed = await repo.claimTask(lockOwner, LEASE_MS, opts.agents);
      if (!claimed) break;
      const outcome = await runOne(claimed.task, claimed.reclaimed, lockOwner);
      if (outcome === "ok") report.processed += 1;
      else if (outcome === "rescheduled") report.rescheduled += 1;
      else report.failed += 1;
    }
  } finally {
    g.__agentQueueRunning = false;
  }
  return report;
}

async function runOne(
  task: AgentTask,
  reclaimed: boolean,
  lockOwner: string
): Promise<"ok" | "failed" | "rescheduled"> {
  const repo = agentRepo();

  const finish = async (patch: Partial<AgentTask>) => {
    // Cancelamento pedido enquanto rodava vale mais que o desfecho.
    const current = await repo.get("tasks", task.id);
    if (current?.status === "cancelado") return;
    await repo.update("tasks", task.id, {
      ...patch,
      updated_at: new Date().toISOString(),
      locked_until: null,
      lock_owner: null,
    });
  };

  // Lease vencido: o processo anterior morreu no meio. Conta tentativa, senão
  // uma tarefa que derruba o servidor seria reprocessada para sempre.
  let attempts = task.attempts;
  if (reclaimed) {
    attempts += 1;
    await logAgentEvent(task.agent, "warn", "task.reclaimed", `Tarefa ${task.kind} retomada após interrupção (tentativa ${attempts}/${task.max_attempts}).`, null, task.id);
    if (attempts >= task.max_attempts) {
      await finish({
        status: "falhou",
        attempts,
        last_error: "Interrompida repetidas vezes antes de terminar.",
        finished_at: new Date().toISOString(),
      });
      return "failed";
    }
    await repo.update("tasks", task.id, { attempts });
  }

  const handler = handlers().get(task.kind);
  const heartbeat = setInterval(() => {
    repo.extendLease(task.id, lockOwner, LEASE_MS).catch(() => {});
  }, HEARTBEAT_MS);

  let result: Record<string, unknown> | null = null;
  let rescheduleAt: Date | null = null;
  const ctx: AgentTaskContext = {
    task,
    progress: async (done, total, label) => {
      await repo.update("tasks", task.id, {
        progress: { done, total, label },
        updated_at: new Date().toISOString(),
      });
    },
    log: (level, message, data) => logAgentEvent(task.agent, level, `task.${task.kind}`, message, data ?? null, task.id),
    setResult: (r) => {
      result = r;
    },
    reschedule: (at) => {
      rescheduleAt = at;
    },
    isCancelled: async () => (await repo.get("tasks", task.id))?.status === "cancelado",
    spend: (kind, amount, note) => recordSpend(task.agent, kind, amount, note ?? null),
  };

  try {
    if (!handler) throw new PermanentTaskError(`Sem handler para ${task.kind}`);
    const fresh = await repo.get("tasks", task.id);
    if (!fresh || fresh.status === "cancelado") return "failed";

    await logAgentEvent(task.agent, "info", "task.started", `Iniciou ${task.kind}.`, null, task.id);
    await handler(ctx);

    if (rescheduleAt) {
      const at = rescheduleAt as Date;
      await finish({ status: "pendente", next_run_at: at.toISOString(), attempts: 0, last_error: null, progress: null });
      await logAgentEvent(task.agent, "info", "task.rescheduled", `${task.kind} adiada para ${at.toISOString()}.`, null, task.id);
      return "rescheduled";
    }
    await finish({
      status: "concluido",
      attempts,
      result,
      last_error: null,
      finished_at: new Date().toISOString(),
    });
    await logAgentEvent(task.agent, "info", "task.completed", `Concluiu ${task.kind}.`, result, task.id);
    return "ok";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitedError) {
      // 429 não é culpa da tarefa: espera o que o provedor pediu, sem queimar tentativa.
      const at = new Date(Date.now() + Math.max(err.retryAfterMs, 5_000));
      await finish({ status: "pendente", next_run_at: at.toISOString(), last_error: message });
      await logAgentEvent(task.agent, "warn", "task.rate_limited", message, null, task.id);
      return "rescheduled";
    }
    attempts += 1;
    const permanent = err instanceof PermanentTaskError;
    if (permanent || attempts >= task.max_attempts) {
      await finish({
        status: "falhou",
        attempts,
        last_error: message,
        finished_at: new Date().toISOString(),
      });
      await logAgentEvent(task.agent, "error", "task.failed", `${task.kind} falhou: ${message}`, null, task.id);
    } else {
      await finish({
        status: "pendente",
        attempts,
        last_error: message,
        next_run_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
      });
      await logAgentEvent(task.agent, "warn", "task.retry", `${task.kind} falhou (${attempts}/${task.max_attempts}), nova tentativa em breve: ${message}`, null, task.id);
    }
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}
