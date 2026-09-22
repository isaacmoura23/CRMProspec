import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { careerRepo, getCareerData, type Owner } from "@/services/career/repository";
import { enqueue, runCareerWorker } from "@/services/career/queue";
import { setEmailChannelOverrideForTests } from "@/services/career/handlers";
import { putFile } from "@/services/career/files";
import { processResendEvent } from "@/services/career/webhook";
import { setCampaignStatus } from "@/services/career/service";
import type { EmailChannel, SendOutcome } from "@/providers/email/types";
import { emptyCareerData, type ApplicationCampaign, type JobApplication, type JobPosting, type ResumeVersion, type CareerProfile } from "@/types/career";

const OWNER: Owner = { owner_id: "user_a", organization_id: "org_1" };

function fakeChannel(outcome: SendOutcome, calls: string[]): EmailChannel {
  return {
    id: "resend",
    name: "Fake",
    isConfigured: () => true,
    async send(email) {
      calls.push(email.idempotencyKey);
      return outcome;
    },
  };
}

async function seed(opts: { channel?: JobApplication["channel"]; campaignStatus?: ApplicationCampaign["status"]; jobSource?: string } = {}) {
  Object.assign(getCareerData(), emptyCareerData());
  const repo = careerRepo();
  const now = new Date().toISOString();
  const profile: CareerProfile = { id: "p1", owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, resume_version_id: "v1", full_name: "Maria", email: "maria@x.com", phone: null, location: null, headline: "Dev", summary: null, experiences: [], education: [], skills: ["react"], languages: [], certifications: [], projects: [], links: [], confirmed: true, extraction_model: "t", created_at: now, updated_at: now };
  await repo.insert("profiles", profile);
  const version: ResumeVersion = { id: "v1", owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, kind: "original", label: "cv", source_version_id: null, file_name: "cv.pdf", storage_key: `${OWNER.owner_id}/v1.pdf`, size_bytes: 8, sha256: "x", page_count: 1, text_status: "ok", text_note: null, pages: [{ page: 1, text: "Maria" }], links: [], created_at: now };
  await repo.insert("resumes", version);
  await putFile(version.storage_key, new TextEncoder().encode("%PDF-1.4"));
  const job: JobPosting = { id: "j1", owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, source: opts.jobSource ?? "demo", external_id: "demo-1", canonical_key: "acme|dev", title: "Dev", company: "Acme", description: "", requirements: [], location: null, work_mode: null, url: "https://example.com/1", apply_url: null, application_email: "vagas@example.com", application_email_evidence: "x", salary: null, contract_type: null, language: "pt", posted_at: null, collected_at: now, expires_at: null, status: "aberta", status_checked_at: null, origin_evidence: "t" };
  await repo.insert("jobs", job);
  const campaign: ApplicationCampaign = { id: "c1", owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, name: "c", status: opts.campaignStatus ?? "ativa", job_ids: ["j1"], recurring: false, roles: [], min_score: 0, resume_version_id: "v1", profile_id: "p1", channel: opts.channel ?? "resend", daily_limit: 10, ends_at: null, template_subject: "Candidatura {{cargo}}", template_body: "Olá {{empresa}}.", sent_today: 0, sent_day: null, next_run_at: now, last_run_at: null, created_at: now, updated_at: now };
  await repo.insert("campaigns", campaign);
  const app: JobApplication = { id: "a1", owner_id: OWNER.owner_id, organization_id: OWNER.organization_id, campaign_id: "c1", job_id: "j1", canonical_key: "acme|dev", profile_id: "p1", resume_version_id: "v1", match_score: 80, channel: opts.channel ?? "resend", recipient: "vagas@example.com", subject: "s", body_text: "b", body_html: "<p>b</p>", job_snapshot: { title: "Dev", company: "Acme", url: "https://example.com/1", description_excerpt: "" }, processing_status: "enfileirada", email_status: null, selection_status: "registrada", provider_message_id: null, idempotency_key: "idem_a1", attempts_count: 0, last_error: null, manual_apply_url: null, sent_at: null, created_at: now, updated_at: now };
  await repo.insert("applications", app);
  return { repo };
}

describe("send_application", () => {
  beforeEach(() => setEmailChannelOverrideForTests(null));
  after(() => setEmailChannelOverrideForTests(null));

  it("envia uma vez, registra tentativa, comprovante e evento", async () => {
    const { repo } = await seed();
    const calls: string[] = [];
    setEmailChannelOverrideForTests(() => fakeChannel({ kind: "accepted", providerMessageId: "re_123" }, calls));
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    await runCareerWorker({ budgetMs: 5_000 });
    const app = (await repo.get(OWNER, "applications", "a1"))!;
    assert.equal(app.processing_status, "concluida");
    assert.equal(app.email_status, "aceito");
    assert.equal(app.provider_message_id, "re_123");
    assert.equal(app.attempts_count, 1);
    assert.deepEqual(calls, ["idem_a1"]);
    const attempts = await repo.list(OWNER, "attempts", { application_id: "a1" });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "sucesso");
    assert.ok((await repo.list(OWNER, "events", { application_id: "a1" })).some((e) => e.type === "email:aceito"));
  });

  it("campanha pausada não envia; cancelada cancela a candidatura", async () => {
    const { repo } = await seed({ campaignStatus: "pausada" });
    const calls: string[] = [];
    setEmailChannelOverrideForTests(() => fakeChannel({ kind: "accepted", providerMessageId: "x" }, calls));
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    await runCareerWorker({ budgetMs: 5_000 });
    assert.equal(calls.length, 0);
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.processing_status, "pendente");

    await setCampaignStatus(OWNER, "c1", "cancelada");
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.processing_status, "cancelada");
    await enqueue(OWNER, "send_application", { application_id: "a1" }, { dedupe: false });
    await runCareerWorker({ budgetMs: 5_000 });
    assert.equal(calls.length, 0);
  });

  it("timeout depois do envio vira resultado incerto e reconcilia com a MESMA chave", async () => {
    const { repo } = await seed();
    const calls: string[] = [];
    let n = 0;
    setEmailChannelOverrideForTests(() => ({
      id: "resend",
      name: "Fake",
      isConfigured: () => true,
      async send(email) {
        calls.push(email.idempotencyKey);
        n += 1;
        return n === 1 ? { kind: "uncertain", error: "timeout" } : { kind: "accepted", providerMessageId: "re_ok" };
      },
    }));
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    await runCareerWorker({ budgetMs: 5_000 });
    let app = (await repo.get(OWNER, "applications", "a1"))!;
    assert.equal(app.processing_status, "resultado_incerto");
    const reconcile = (await repo.list(OWNER, "queue", { kind: "send_application" })).find((j) => j.status === "pendente");
    assert.ok(reconcile, "job de reconciliação agendado");
    await repo.updateAny("queue", reconcile!.id, { next_run_at: new Date(Date.now() - 1).toISOString() });
    await runCareerWorker({ budgetMs: 5_000 });
    app = (await repo.get(OWNER, "applications", "a1"))!;
    assert.equal(app.processing_status, "concluida");
    assert.deepEqual(calls, ["idem_a1", "idem_a1"]);
    assert.equal((await repo.list(OWNER, "attempts", { application_id: "a1" })).length, 2);
  });

  it("sem credenciais do canal, falha explicada e sem retry infinito", async () => {
    const { repo } = await seed();
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    await runCareerWorker({ budgetMs: 5_000 });
    const app = (await repo.get(OWNER, "applications", "a1"))!;
    assert.equal(app.processing_status, "falhou");
    assert.match(app.last_error ?? "", /Resend não configurado/);
  });

  it("Gmail desconectado falha com motivo claro", async () => {
    const { repo } = await seed({ channel: "gmail" });
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    await runCareerWorker({ budgetMs: 5_000 });
    assert.match((await repo.get(OWNER, "applications", "a1"))?.last_error ?? "", /Gmail desconectada/);
  });

  it("falha por cota (429) reagenda sem nova tentativa contada como falha; rejeição permanente encerra", async () => {
    const { repo } = await seed();
    setEmailChannelOverrideForTests(() => fakeChannel({ kind: "rate_limited", retryAfterMs: 30_000 }, []));
    await enqueue(OWNER, "send_application", { application_id: "a1" });
    const r = await runCareerWorker({ budgetMs: 5_000 });
    assert.equal(r.rescheduled, 1);
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.processing_status, "enfileirada");

    setEmailChannelOverrideForTests(() => fakeChannel({ kind: "rejected", error: "domínio não verificado", permanent: true }, []));
    const job = (await repo.list(OWNER, "queue", { kind: "send_application" }))[0]!;
    await repo.updateAny("queue", job.id, { next_run_at: new Date(Date.now() - 1).toISOString() });
    await runCareerWorker({ budgetMs: 5_000 });
    const app = (await repo.get(OWNER, "applications", "a1"))!;
    assert.equal(app.processing_status, "falhou");
    assert.equal(app.last_error, "domínio não verificado");
  });
});

describe("webhook do Resend", () => {
  it("ignora evento repetido, aplica fora de ordem sem regredir e marca bounce como terminal", async () => {
    const { repo } = await seed();
    await repo.update(OWNER, "applications", "a1", { provider_message_id: "re_1", email_status: "aceito", processing_status: "concluida" });

    const delivered = await processResendEvent("svix_1", { type: "email.delivered", created_at: "2026-09-21T10:05:00Z", data: { email_id: "re_1" } });
    assert.equal(delivered.handled, true);
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.email_status, "entregue");

    const dup = await processResendEvent("svix_1", { type: "email.delivered", data: { email_id: "re_1" } });
    assert.equal(dup.handled, false);

    // "sent" chegando depois de "delivered" não regride o status
    await processResendEvent("svix_2", { type: "email.sent", created_at: "2026-09-21T10:04:00Z", data: { email_id: "re_1" } });
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.email_status, "entregue");

    await processResendEvent("svix_3", { type: "email.bounced", data: { email_id: "re_1", bounce: { message: "mailbox full" } } });
    assert.equal((await repo.get(OWNER, "applications", "a1"))?.email_status, "devolvido");

    const unknown = await processResendEvent("svix_4", { type: "email.delivered", data: { email_id: "nao_existe" } });
    assert.equal(unknown.handled, false);
    assert.equal((await repo.list(OWNER, "events", { application_id: "a1" })).length, 3);
  });
});
