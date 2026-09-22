import "server-only";
import { after } from "next/server";
import { uid } from "@/lib/utils";
import { careerRepo, type Owner } from "@/services/career/repository";
import { RateLimitedError } from "@/providers/jobs/types";
import type { CareerJob, CareerJobKind } from "@/types/career";

/**
 * Fila durável do módulo Carreira.
 *
 * Jobs vivem no banco (ou no snapshot, em demo) com `next_run_at`, lease
 * (`locked_until`/`lock_owner`), tentativas e backoff com jitter. O worker
 * (`runCareerWorker`) é acionado de três formas, todas idempotentes:
 *
 *   1. `kickWorker()` depois de uma action que enfileira algo — usa
 *      `after()` só para responder rápido; se a plataforma cortar a
 *      execução, o lease expira e outro worker retoma o job;
 *   2. a rota autenticada `/api/career/worker` (cron externo/Vercel Cron);
 *   3. a própria página /carreira, quando há jobs vencidos.
 *
 * Nada aqui depende de timers em memória para sobreviver: reiniciar o
 * processo só atrasa o job até o próximo acionamento.
 */

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 4;

export type JobHandler = (job: CareerJob, ctx: HandlerContext) => Promise<void>;

export interface HandlerContext {
  /** Atualiza progresso visível na interface. */
  progress(done: number, total: number, label: string): Promise<void>;
  /** Reagenda o próprio job sem contar como falha (ex.: tick recorrente). */
  reschedule(at: Date): void;
}

class Rescheduled {
  constructor(public at: Date) {}
}

const handlers = new Map<CareerJobKind, JobHandler>();

export function registerHandler(kind: CareerJobKind, handler: JobHandler) {
  handlers.set(kind, handler);
}

export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random)); // jitter: 50% a 150%
}

export async function enqueue(
  owner: Owner,
  kind: CareerJobKind,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; maxAttempts?: number; dedupe?: boolean } = {}
): Promise<CareerJob> {
  const repo = careerRepo();
  if (opts.dedupe !== false) {
    const pending = await repo.list(owner, "queue", { kind, status: "pendente" });
    const same = pending.find((j) => JSON.stringify(j.payload) === JSON.stringify(payload));
    if (same) return same;
  }
  const now = new Date().toISOString();
  const job: CareerJob = {
    id: uid("cjob"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    kind,
    payload,
    status: "pendente",
    attempts: 0,
    max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    next_run_at: (opts.runAt ?? new Date()).toISOString(),
    locked_until: null,
    lock_owner: null,
    last_error: null,
    progress: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };
  return repo.insert("queue", job);
}

export async function cancelPendingJobs(owner: Owner, filter: (job: CareerJob) => boolean): Promise<number> {
  const repo = careerRepo();
  const jobs = await repo.list(owner, "queue");
  let n = 0;
  for (const job of jobs) {
    if ((job.status === "pendente" || job.status === "processando") && filter(job)) {
      await repo.update(owner, "queue", job.id, { status: "cancelado", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      n += 1;
    }
  }
  return n;
}

type GlobalWithWorker = typeof globalThis & { __careerWorkerRunning?: boolean };

/** Agenda uma passada do worker depois da resposta atual. */
export function kickWorker() {
  try {
    after(() => runCareerWorker({ budgetMs: 55_000 }));
  } catch {
    // Fora de um contexto de requisição (ex.: testes): ignora.
  }
}

export interface WorkerReport {
  processed: number;
  failed: number;
  rescheduled: number;
  skipped: boolean;
}

export async function runCareerWorker(opts: { budgetMs?: number; maxJobs?: number } = {}): Promise<WorkerReport> {
  const g = globalThis as GlobalWithWorker;
  const report: WorkerReport = { processed: 0, failed: 0, rescheduled: 0, skipped: false };
  // Um laço por instância; outras instâncias competem pelo lease no banco.
  if (g.__careerWorkerRunning) {
    report.skipped = true;
    return report;
  }
  g.__careerWorkerRunning = true;
  const deadline = Date.now() + (opts.budgetMs ?? 55_000);
  const maxJobs = opts.maxJobs ?? 25;
  const lockOwner = `worker_${process.pid}_${uid()}`;
  const repo = careerRepo();

  try {
    while (Date.now() < deadline && report.processed + report.failed + report.rescheduled < maxJobs) {
      const job = await repo.claimJob(lockOwner, LEASE_MS);
      if (!job) break;
      const outcome = await runOne(job, lockOwner);
      if (outcome === "ok") report.processed += 1;
      else if (outcome === "rescheduled") report.rescheduled += 1;
      else report.failed += 1;
    }
  } finally {
    g.__careerWorkerRunning = false;
  }
  return report;
}

async function runOne(job: CareerJob, lockOwner: string): Promise<"ok" | "failed" | "rescheduled"> {
  const repo = careerRepo();
  const handler = handlers.get(job.kind);
  const heartbeat = setInterval(() => {
    repo.extendLease(job.id, lockOwner, LEASE_MS).catch(() => {});
  }, HEARTBEAT_MS);

  const finish = async (patch: Partial<CareerJob>) => {
    await repo.updateAny("queue", job.id, { ...patch, updated_at: new Date().toISOString(), locked_until: null, lock_owner: null });
  };

  try {
    if (!handler) throw new Error(`Sem handler para ${job.kind}`);
    // Cancelamento pedido enquanto o job esperava: não executa.
    const fresh = await repo.getAny("queue", job.id);
    if (!fresh || fresh.status === "cancelado") return "failed";

    let rescheduleAt: Date | null = null;
    const ctx: HandlerContext = {
      progress: async (done, total, label) => {
        await repo.updateAny("queue", job.id, { progress: { done, total, label }, updated_at: new Date().toISOString() });
      },
      reschedule: (at) => {
        rescheduleAt = at;
      },
    };
    await handler(job, ctx);
    if (rescheduleAt) {
      await finish({ status: "pendente", next_run_at: (rescheduleAt as Date).toISOString(), attempts: 0, last_error: null, progress: null });
      return "rescheduled";
    }
    await finish({ status: "concluido", finished_at: new Date().toISOString(), last_error: null });
    return "ok";
  } catch (err) {
    if (err instanceof Rescheduled) {
      await finish({ status: "pendente", next_run_at: err.at.toISOString() });
      return "rescheduled";
    }
    if (err instanceof RateLimitedError) {
      // 429 não é culpa do job: espera o que o provedor pediu, sem queimar tentativa.
      const at = new Date(Date.now() + Math.max(err.retryAfterMs, 5_000));
      await finish({ status: "pendente", next_run_at: at.toISOString(), last_error: err.message });
      return "rescheduled";
    }
    const attempts = job.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (attempts >= job.max_attempts) {
      await finish({ status: "falhou", attempts, last_error: message, finished_at: new Date().toISOString() });
    } else {
      await finish({ status: "pendente", attempts, last_error: message, next_run_at: new Date(Date.now() + backoffMs(attempts)).toISOString() });
    }
    console.error(`[career/queue] ${job.kind} ${job.id} falhou (${attempts}/${job.max_attempts}):`, message);
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

export function rescheduleAt(at: Date): never {
  throw new Rescheduled(at);
}
