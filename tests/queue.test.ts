import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { careerRepo, getCareerData, UniqueViolationError, type Owner } from "@/services/career/repository";
import { backoffMs, enqueue, cancelPendingJobs, registerHandler, runCareerWorker } from "@/services/career/queue";
import { RateLimitedError } from "@/providers/jobs/types";
import { emptyCareerData, type CareerJob, type JobApplication } from "@/types/career";

const OWNER: Owner = { owner_id: "user_a", organization_id: "org_1" };
const OTHER: Owner = { owner_id: "user_b", organization_id: "org_1" };

function reset() {
  Object.assign(getCareerData(), emptyCareerData());
}

describe("repositório local: isolamento e unicidade", () => {
  beforeEach(reset);

  it("um titular não enxerga nem altera dados de outro, mesmo na mesma organização", async () => {
    const repo = careerRepo();
    await repo.insert("jobs", job("j1", OWNER));
    assert.equal((await repo.list(OTHER, "jobs")).length, 0);
    assert.equal(await repo.get(OTHER, "jobs", "j1"), null);
    assert.equal(await repo.update(OTHER, "jobs", "j1", { title: "hack" }), null);
    assert.equal(await repo.remove(OTHER, "jobs", { id: "j1" }), 0);
    assert.equal((await repo.get(OWNER, "jobs", "j1"))?.title, "Dev");
  });

  it("deduplica vaga por chave canônica e candidatura por candidato+vaga", async () => {
    const repo = careerRepo();
    await repo.insert("jobs", job("j1", OWNER));
    await assert.rejects(repo.insert("jobs", job("j2", OWNER)), UniqueViolationError);
    await repo.insert("applications", app("a1", "j1"));
    await assert.rejects(repo.insert("applications", { ...app("a2", "j1"), campaign_id: "outra", channel: "gmail" }), UniqueViolationError);
    // cancelada não bloqueia nova candidatura
    await repo.update(OWNER, "applications", "a1", { processing_status: "cancelada" });
    await repo.insert("applications", app("a3", "j1"));
  });
});

describe("fila durável", () => {
  beforeEach(reset);

  it("backoff cresce com jitter e tem teto", () => {
    assert.ok(backoffMs(1, 0.5) >= 30_000 && backoffMs(1, 0.5) <= 30_000 * 1.5);
    assert.ok(backoffMs(2, 0) < backoffMs(3, 0));
    assert.equal(backoffMs(20, 0.5), 30 * 60_000);
  });

  it("enqueue deduplica jobs pendentes idênticos", async () => {
    const a = await enqueue(OWNER, "search_jobs", { trigger: "manual" });
    const b = await enqueue(OWNER, "search_jobs", { trigger: "manual" });
    assert.equal(a.id, b.id);
    const c = await enqueue(OWNER, "search_jobs", { trigger: "manual" }, { dedupe: false });
    assert.notEqual(a.id, c.id);
  });

  it("duas execuções concorrentes nunca pegam o mesmo job (lease)", async () => {
    const repo = careerRepo();
    await enqueue(OWNER, "recheck_job", { job_id: "x" });
    const first = await repo.claimJob("w1", 60_000);
    const second = await repo.claimJob("w2", 60_000);
    assert.ok(first);
    assert.equal(second, null, "o segundo worker não deve reclamar o job trancado");
    assert.equal(await repo.extendLease(first!.id, "w2", 60_000), false, "outro worker não estende o lease");
    assert.equal(await repo.extendLease(first!.id, "w1", 60_000), true);
  });

  it("job abandonado (worker reiniciado) é retomado quando o lease expira", async () => {
    const repo = careerRepo();
    const job = await enqueue(OWNER, "recheck_job", { job_id: "x" });
    await repo.updateAny("queue", job.id, { status: "processando", lock_owner: "morto", locked_until: new Date(Date.now() - 1000).toISOString() });
    const claimed = await repo.claimJob("novo", 60_000);
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.lock_owner, "novo");
  });

  it("worker: sucesso conclui, falha reagenda com backoff e esgota tentativas; 429 não queima tentativa", async () => {
    const repo = careerRepo();
    let calls = 0;
    registerHandler("recheck_job", async (j) => {
      calls += 1;
      if (j.payload.mode === "fail") throw new Error("boom");
      if (j.payload.mode === "rate") throw new RateLimitedError(5_000);
    });
    const ok = await enqueue(OWNER, "recheck_job", { mode: "ok" });
    const fail = await enqueue(OWNER, "recheck_job", { mode: "fail" }, { maxAttempts: 2 });
    const rate = await enqueue(OWNER, "recheck_job", { mode: "rate" });

    const r1 = await runCareerWorker({ budgetMs: 5_000 });
    assert.equal(r1.processed, 1);
    assert.equal(r1.failed, 1);
    assert.equal(r1.rescheduled, 1);
    assert.equal((await repo.getAny("queue", ok.id))?.status, "concluido");
    const f = (await repo.getAny("queue", fail.id))!;
    assert.equal(f.status, "pendente");
    assert.equal(f.attempts, 1);
    assert.ok(Date.parse(f.next_run_at) > Date.now() + 10_000, "reagendado no futuro com backoff");
    const r = (await repo.getAny("queue", rate.id))!;
    assert.equal(r.attempts, 0, "429 não conta como tentativa");
    assert.ok(Date.parse(r.next_run_at) >= Date.now() + 4_000);

    // força o vencimento e roda de novo: a falha esgota o máximo de tentativas
    await repo.updateAny("queue", fail.id, { next_run_at: new Date(Date.now() - 1).toISOString() });
    await repo.updateAny("queue", rate.id, { next_run_at: new Date(Date.now() + 60_000).toISOString() });
    await runCareerWorker({ budgetMs: 5_000 });
    assert.equal((await repo.getAny("queue", fail.id))?.status, "falhou");
    assert.equal(calls, 4);
  });

  it("cancelamento impede a execução de job já enfileirado", async () => {
    let ran = false;
    registerHandler("recheck_job", async () => {
      ran = true;
    });
    const job = await enqueue(OWNER, "recheck_job", { job_id: "y" });
    assert.equal(await cancelPendingJobs(OWNER, (j) => j.id === job.id), 1);
    await runCareerWorker({ budgetMs: 2_000 });
    assert.equal(ran, false);
  });
});

function job(id: string, owner: Owner) {
  return {
    id, owner_id: owner.owner_id, organization_id: owner.organization_id, source: "demo", external_id: id, canonical_key: "acme|dev",
    title: "Dev", company: "Acme", description: "", requirements: [], location: null, work_mode: null, url: "https://example.com/1", apply_url: null,
    application_email: null, application_email_evidence: null, salary: null, contract_type: null, language: null, posted_at: null,
    collected_at: new Date().toISOString(), expires_at: null, status: "aberta" as const, status_checked_at: null, origin_evidence: "t",
  };
}

function app(id: string, jobId: string): JobApplication {
  return {
    id, owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, campaign_id: "c1", job_id: jobId, canonical_key: "acme|dev", profile_id: "p1",
    resume_version_id: "v1", match_score: 80, channel: "resend", recipient: "vagas@example.com", subject: "s", body_text: "b", body_html: "<p>b</p>",
    job_snapshot: { title: "Dev", company: "Acme", url: "https://example.com/1", description_excerpt: "" }, processing_status: "enfileirada",
    email_status: null, selection_status: "registrada", provider_message_id: null, idempotency_key: `k_${id}`, attempts_count: 0, last_error: null,
    manual_apply_url: null, sent_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

export type { CareerJob };
