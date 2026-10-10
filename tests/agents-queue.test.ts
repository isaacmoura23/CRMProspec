import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RateLimitedError } from "@/providers/jobs/types";
import {
  agentRepo,
  getAgentData,
  resetAgentRepoForTests,
  UniqueViolationError,
} from "@/services/agents/repository";
import {
  PermanentTaskError,
  cancelAgentTask,
  enqueueAgentTask,
  registerAgentHandler,
  runAgentQueue,
} from "@/services/agents/queue";
import { emptyAgentData } from "@/types/agents";

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
}

const ALL = ["niche-analyst", "prospector"] as const;

describe("fila dos agentes: enfileirar", () => {
  beforeEach(reset);

  it("deduplica tarefas vivas com a mesma chave, mas libera depois de concluída", async () => {
    const a = await enqueueAgentTask({ agent: "prospector", kind: "t.dedupe", dedupeKey: "k1" });
    const b = await enqueueAgentTask({ agent: "prospector", kind: "t.dedupe", dedupeKey: "k1" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.task.id, a.task.id);

    await agentRepo().update("tasks", a.task.id, { status: "concluido" });
    const c = await enqueueAgentTask({ agent: "prospector", kind: "t.dedupe", dedupeKey: "k1" });
    assert.equal(c.created, true);
    assert.notEqual(c.task.id, a.task.id);
  });

  it("o repositório recusa chave de dedupe viva repetida", async () => {
    const t = (await enqueueAgentTask({ agent: "prospector", kind: "t.x", dedupeKey: "k2" })).task;
    await assert.rejects(agentRepo().insert("tasks", { ...t, id: "outro" }), UniqueViolationError);
  });
});

describe("fila dos agentes: reivindicar", () => {
  beforeEach(reset);

  it("seis execuções simultâneas rodam a tarefa uma única vez", async () => {
    let calls = 0;
    registerAgentHandler("t.once", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
    });
    await enqueueAgentTask({ agent: "prospector", kind: "t.once" });
    const reports = await Promise.all(Array.from({ length: 6 }, () => runAgentQueue({ agents: ALL, budgetMs: 5_000 })));
    assert.equal(calls, 1);
    assert.equal(reports.filter((r) => r.processed === 1).length, 1);
    assert.equal(reports.filter((r) => r.skipped).length, 5);
  });

  it("duas reivindicações diretas nunca pegam a mesma tarefa (lease)", async () => {
    const repo = agentRepo();
    await enqueueAgentTask({ agent: "prospector", kind: "t.lease" });
    const first = await repo.claimTask("w1", 60_000, ALL);
    const second = await repo.claimTask("w2", 60_000, ALL);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(await repo.extendLease(first!.task.id, "w2", 60_000), false);
    assert.equal(await repo.extendLease(first!.task.id, "w1", 60_000), true);
  });

  it("agente fora da lista liberada não consome a tarefa — ela fica intacta na fila", async () => {
    const repo = agentRepo();
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.paused" });
    assert.equal(await repo.claimTask("w", 60_000, []), null);
    assert.equal(await repo.claimTask("w", 60_000, ["niche-analyst"]), null);
    assert.equal((await repo.get("tasks", task.id))?.status, "pendente");
    assert.equal(await repo.countDueTasks(["prospector"]), 1);
    assert.equal(await repo.countDueTasks(["niche-analyst"]), 0);
  });

  it("tarefa abandonada (processo morto) é retomada com o lease vencido e conta tentativa", async () => {
    const repo = agentRepo();
    registerAgentHandler("t.crash", async () => {});
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.crash" });
    await repo.update("tasks", task.id, {
      status: "processando",
      lock_owner: "morto",
      locked_until: new Date(Date.now() - 1_000).toISOString(),
    });
    const report = await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    assert.equal(report.processed, 1);
    const after = (await repo.get("tasks", task.id))!;
    assert.equal(after.status, "concluido");
    assert.equal(after.attempts, 1, "a retomada conta como tentativa");
  });

  it("tarefa que derruba o processo repetidamente acaba falhando em vez de repetir para sempre", async () => {
    const repo = agentRepo();
    let calls = 0;
    registerAgentHandler("t.loop", async () => {
      calls += 1;
    });
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.loop", maxAttempts: 2 });
    const expire = () =>
      repo.update("tasks", task.id, {
        status: "processando",
        lock_owner: "morto",
        locked_until: new Date(Date.now() - 1_000).toISOString(),
        attempts: 1,
      });
    await expire();
    await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    const after = (await repo.get("tasks", task.id))!;
    assert.equal(after.status, "falhou");
    assert.equal(calls, 0, "o handler não roda de novo depois do limite");
  });
});

describe("fila dos agentes: desfechos", () => {
  beforeEach(reset);

  it("sucesso conclui e guarda o resultado; falha reagenda com backoff e esgota; 429 não queima tentativa", async () => {
    const repo = agentRepo();
    let calls = 0;
    registerAgentHandler("t.mix", async (ctx) => {
      calls += 1;
      if (ctx.task.payload.mode === "fail") throw new Error("boom");
      if (ctx.task.payload.mode === "rate") throw new RateLimitedError(5_000);
      ctx.setResult({ feito: true });
    });
    const ok = (await enqueueAgentTask({ agent: "prospector", kind: "t.mix", payload: { mode: "ok" } })).task;
    const fail = (await enqueueAgentTask({ agent: "prospector", kind: "t.mix", payload: { mode: "fail" }, maxAttempts: 2 })).task;
    const rate = (await enqueueAgentTask({ agent: "prospector", kind: "t.mix", payload: { mode: "rate" } })).task;

    const r1 = await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    assert.equal(r1.processed, 1);
    assert.equal(r1.failed, 1);
    assert.equal(r1.rescheduled, 1);

    const okRow = (await repo.get("tasks", ok.id))!;
    assert.equal(okRow.status, "concluido");
    assert.deepEqual(okRow.result, { feito: true });
    const failRow = (await repo.get("tasks", fail.id))!;
    assert.equal(failRow.status, "pendente");
    assert.equal(failRow.attempts, 1);
    assert.ok(Date.parse(failRow.next_run_at) > Date.now() + 10_000, "reagendada no futuro com backoff");
    const rateRow = (await repo.get("tasks", rate.id))!;
    assert.equal(rateRow.attempts, 0, "429 não conta como tentativa");
    assert.ok(Date.parse(rateRow.next_run_at) >= Date.now() + 4_000);

    await repo.update("tasks", fail.id, { next_run_at: new Date(Date.now() - 1).toISOString() });
    await repo.update("tasks", rate.id, { next_run_at: new Date(Date.now() + 60_000).toISOString() });
    await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    assert.equal((await repo.get("tasks", fail.id))?.status, "falhou");
    assert.equal(calls, 4);
  });

  it("erro permanente não é repetido", async () => {
    registerAgentHandler("t.perm", async () => {
      throw new PermanentTaskError("parâmetro inválido");
    });
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.perm" });
    await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    const row = (await agentRepo().get("tasks", task.id))!;
    assert.equal(row.status, "falhou");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "parâmetro inválido");
  });

  it("reagendar a própria tarefa não conta como falha nem tentativa", async () => {
    const future = new Date(Date.now() + 3_600_000);
    registerAgentHandler("t.resched", async (ctx) => ctx.reschedule(future));
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.resched" });
    const report = await runAgentQueue({ agents: ALL, budgetMs: 5_000 });
    assert.equal(report.rescheduled, 1);
    const row = (await agentRepo().get("tasks", task.id))!;
    assert.equal(row.status, "pendente");
    assert.equal(row.attempts, 0);
    assert.equal(row.next_run_at, future.toISOString());
  });

  it("cancelar uma tarefa pendente impede a execução", async () => {
    let ran = false;
    registerAgentHandler("t.cancel", async () => {
      ran = true;
    });
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.cancel" });
    assert.ok(await cancelAgentTask(task.id));
    await runAgentQueue({ agents: ALL, budgetMs: 2_000 });
    assert.equal(ran, false);
    assert.equal((await agentRepo().get("tasks", task.id))?.status, "cancelado");
  });

  it("cancelamento pedido enquanto a tarefa roda vale mais que o desfecho", async () => {
    registerAgentHandler("t.cancel-mid", async (ctx) => {
      await cancelAgentTask(ctx.task.id);
      assert.equal(await ctx.isCancelled(), true);
    });
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.cancel-mid" });
    await runAgentQueue({ agents: ALL, budgetMs: 2_000 });
    assert.equal((await agentRepo().get("tasks", task.id))?.status, "cancelado");
  });

  it("tarefa sem handler falha com a causa, sem travar a fila", async () => {
    const { task } = await enqueueAgentTask({ agent: "prospector", kind: "t.sem-handler" });
    const report = await runAgentQueue({ agents: ALL, budgetMs: 2_000 });
    assert.equal(report.failed, 1);
    const row = (await agentRepo().get("tasks", task.id))!;
    assert.equal(row.status, "falhou");
    assert.match(row.last_error ?? "", /Sem handler/);
  });
});
