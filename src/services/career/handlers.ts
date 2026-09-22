import "server-only";
import { uid } from "@/lib/utils";
import { aiExtractProfile, aiReviewResume, aiWriteApplication } from "@/ai/career";
import { isLlmConfigured, llmModelName } from "@/ai/client";
import { isValidEmail, sanitizeHeader, textToHtml } from "@/lib/job-text";
import { getOcrProvider } from "@/providers/ocr";
import { activeJobProviders, getJobProvider } from "@/providers/jobs/registry";
import { RateLimitedError, type RawJob } from "@/providers/jobs/types";
import { GmailChannel } from "@/providers/email/gmail";
import { ResendChannel } from "@/providers/email/resend";
import type { EmailChannel, SendOutcome } from "@/providers/email/types";
import { analyzeResumeHeuristic, extractProfileHeuristic, guardSuggestion, pageOf } from "@/services/career/analysis-engine";
import { getFile } from "@/services/career/files";
import { classifyLink, inspectLink } from "@/services/career/link-inspector";
import { defaultTemplates, renderApplicationMessage } from "@/services/career/messaging";
import { resumeFullText } from "@/services/career/pdf";
import { enqueue, registerHandler, type HandlerContext } from "@/services/career/queue";
import { careerRepo, UniqueViolationError, type Owner } from "@/services/career/repository";
import { appendEvent, buildSearchTerms, recomputeMatch, resolveChannel, upsertJobFromRaw } from "@/services/career/service";
import type {
  ApplicationAttempt,
  ApplicationCampaign,
  CareerJob,
  CareerPreferences,
  CareerProfile,
  JobApplication,
  JobMatch,
  JobPosting,
  LinkCheck,
  ResumeAnalysis,
  ResumeSuggestion,
  ResumeVersion,
} from "@/types/career";

/**
 * Handlers da fila. Cada um é idempotente o bastante para ser repetido
 * depois de um lease expirado: relê o estado antes de agir e nunca assume
 * que a execução anterior não aconteceu.
 */

const LINKS_PER_RESUME = 15;
const RECURRING_INTERVAL_MS = 6 * 60 * 60_000;

function ownerOfJob(job: CareerJob): Owner {
  return { owner_id: job.owner_id, organization_id: job.organization_id };
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* analyze_resume                                                      */
/* ------------------------------------------------------------------ */

registerHandler("analyze_resume", async (job, ctx) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const versionId = String(job.payload.resume_version_id);
  let version = await repo.get(owner, "resumes", versionId);
  if (!version) return; // apagada enquanto esperava

  await ctx.progress(0, 4, "Lendo o documento");

  /* OCR quando o PDF é digitalizado e há provedor */
  if (version.text_status === "ocr_pendente") {
    const ocr = getOcrProvider();
    if (!ocr.isConfigured()) {
      await repo.update(owner, "resumes", versionId, { text_status: "ocr_indisponivel", text_note: "OCR não configurado (OCR_SPACE_API_KEY)." });
      return;
    }
    const bytes = await getFile(version.storage_key);
    if (!bytes) throw new Error("Arquivo do currículo indisponível para OCR");
    const texts = await ocr.recognizePdf(bytes, "por");
    const pages = texts.map((text, i) => ({ page: i + 1, text: text.slice(0, 20_000) }));
    const total = pages.reduce((n, p) => n + p.text.length, 0);
    version = (await repo.update(owner, "resumes", versionId, {
      pages,
      text_status: total > 80 ? "ok" : "sem_texto",
      text_note: total > 80 ? `Texto obtido por OCR (${ocr.name}); confira a extração.` : "O OCR não encontrou texto legível.",
    })) ?? version;
    if (total <= 80) return;
  }

  const existingAnalysis = (await repo.list(owner, "analyses", { resume_version_id: versionId }))[0];
  const analysisId = existingAnalysis?.id ?? uid("an");
  const base: ResumeAnalysis = existingAnalysis ?? {
    id: analysisId,
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    resume_version_id: versionId,
    status: "processando",
    score: null,
    criteria: [],
    issues: [],
    suggestions: [],
    not_evaluated: [],
    context: { profession: null, seniority: null, country: null },
    model: "engine/heuristic-v1",
    error: null,
    created_at: nowIso(),
    finished_at: null,
  };
  if (!existingAnalysis) await repo.insert("analyses", base);
  else await repo.update(owner, "analyses", analysisId, { status: "processando", error: null });

  try {
    /* Perfil: LLM quando houver, sobre a base heurística; perfil confirmado não é sobrescrito */
    await ctx.progress(1, 4, "Extraindo o perfil profissional");
    const profile = (await repo.list(owner, "profiles"))[0];
    const heuristic = extractProfileHeuristic(version.pages, version.links);
    let model = "engine/heuristic-v1";
    if (profile && !profile.confirmed) {
      const ai = await aiExtractProfile(version.pages);
      if (ai) {
        model = ai.model;
        const o = ai.output;
        await repo.update(owner, "profiles", profile.id, {
          full_name: o.full_name ?? heuristic.full_name,
          email: o.email ?? heuristic.email,
          phone: o.phone ?? heuristic.phone,
          location: o.location ?? heuristic.location,
          headline: o.headline ?? heuristic.headline,
          summary: o.summary ?? heuristic.summary,
          experiences: o.experiences.length ? o.experiences : heuristic.experiences,
          education: o.education.length ? o.education : heuristic.education,
          skills: [...new Set([...o.skills, ...heuristic.skills])].slice(0, 80),
          languages: o.languages.length ? o.languages : heuristic.languages,
          certifications: o.certifications.length ? o.certifications : heuristic.certifications,
          projects: o.projects.length ? o.projects : heuristic.projects,
          links: [...new Set([...heuristic.links, ...o.projects.map((p) => p.url).filter((u): u is string => Boolean(u))])],
          extraction_model: model,
          updated_at: nowIso(),
        });
      }
    }
    const current = (await repo.list(owner, "profiles"))[0];
    const draft = current ? { ...current } : heuristic;

    /* Análise heurística + revisão por LLM com filtros anti-invenção */
    await ctx.progress(2, 4, "Avaliando conteúdo e estrutura");
    const engine = analyzeResumeHeuristic(version.pages, version.links, draft, { llmAvailable: isLlmConfigured(), layoutAvailable: false });
    const fullText = resumeFullText(version.pages);
    const suggestions: ResumeSuggestion[] = [...engine.suggestions];
    let analysisModel = "engine/heuristic-v1";
    const observations: string[] = [];
    const review = await aiReviewResume(version.pages, engine.context);
    if (review) {
      analysisModel = `${llmModelName()}+engine/heuristic-v1`;
      let discarded = 0;
      for (const r of review.output.rewrites) {
        const guarded = guardSuggestion({ ...r, page: pageOf(version.pages, r.original) }, fullText);
        if (guarded) suggestions.push(guarded);
        else discarded += 1;
      }
      for (const s of review.output.spelling_and_grammar) {
        const guarded = guardSuggestion({ ...s, rationale: "Correção ortográfica/gramatical.", priority: "media", page: pageOf(version.pages, s.original), needs_user_input: false }, fullText);
        if (guarded) suggestions.push(guarded);
        else discarded += 1;
      }
      observations.push(...review.output.observations);
      if (discarded > 0) observations.push(`${discarded} sugestão(ões) do modelo foram descartadas por não citarem trecho literal do currículo ou por introduzirem números não presentes no documento.`);
    }
    // Preserva decisões já tomadas em sugestões idênticas (reanálise).
    const previous = existingAnalysis?.suggestions ?? [];
    const merged = new Map<string, ResumeSuggestion>();
    for (const s of suggestions) {
      const key = `${s.original}::${s.suggested}`;
      if (merged.has(key)) continue;
      const old = previous.find((p) => p.original === s.original && p.suggested === s.suggested);
      merged.set(key, old ? { ...s, id: old.id, status: old.status, edited: old.edited } : s);
    }

    await ctx.progress(3, 4, "Registrando resultados");
    await repo.update(owner, "analyses", analysisId, {
      status: "concluido",
      score: engine.score,
      criteria: engine.criteria,
      issues: engine.issues,
      suggestions: [...merged.values()],
      not_evaluated: [...engine.not_evaluated, ...observations],
      context: engine.context,
      model: analysisModel,
      error: null,
      finished_at: nowIso(),
    });

    if (version.links.length > 0) await enqueue(owner, "check_links", { resume_version_id: versionId });
    await ctx.progress(4, 4, "Análise concluída");
  } catch (err) {
    await repo.update(owner, "analyses", analysisId, { status: "falhou", error: err instanceof Error ? err.message : String(err), finished_at: nowIso() });
    throw err;
  }
});

/* ------------------------------------------------------------------ */
/* check_links                                                         */
/* ------------------------------------------------------------------ */

registerHandler("check_links", async (job, ctx) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const versionId = String(job.payload.resume_version_id);
  const version = await repo.get(owner, "resumes", versionId);
  if (!version) return;
  const profile = (await repo.list(owner, "profiles"))[0];
  const ctxResume = { fullName: profile?.full_name ?? "", skills: profile?.skills ?? [] };

  const unique = new Map<string, ResumeVersion["links"][number]>();
  for (const l of version.links) if (!unique.has(l.url)) unique.set(l.url, l);
  const links = [...unique.values()].slice(0, LINKS_PER_RESUME);
  const existing = await repo.list(owner, "link_checks", { resume_version_id: versionId });

  let done = 0;
  for (const link of links) {
    await ctx.progress(done, links.length, `Inspecionando ${new URL(link.url).hostname}`);
    const kind = classifyLink(link.url);
    let row = existing.find((c) => c.url === link.url);
    if (!row) {
      row = {
        id: uid("lk"),
        owner_id: owner.owner_id,
        organization_id: owner.organization_id,
        resume_version_id: versionId,
        url: link.url,
        final_url: null,
        kind,
        status: "pendente",
        http_status: null,
        checked_at: null,
        content_summary: null,
        evidence: [],
        limitations: [],
        suggestions: [],
        consistent_with_resume: null,
        page: link.page,
      } satisfies LinkCheck;
      await repo.insert("link_checks", row);
    } else if (row.status !== "pendente" && row.checked_at && Date.now() - Date.parse(row.checked_at) < 6 * 3_600_000) {
      done += 1;
      continue; // já inspecionado há pouco (reexecução após lease expirado)
    }
    const result = await inspectLink(link.url, kind, ctxResume);
    await repo.update(owner, "link_checks", row.id, { ...result, checked_at: nowIso() });
    done += 1;
  }
  if (version.links.length > LINKS_PER_RESUME) {
    await ctx.progress(links.length, links.length, `${version.links.length - LINKS_PER_RESUME} link(s) além do limite não foram visitados`);
  }
});

/* ------------------------------------------------------------------ */
/* search_jobs                                                         */
/* ------------------------------------------------------------------ */

async function runSearch(owner: Owner, profile: CareerProfile, prefs: CareerPreferences | null, ctx: HandlerContext, roles: string[] = []): Promise<{ found: number; created: number; errors: string[] }> {
  const repo = careerRepo();
  const terms = roles.length ? roles : buildSearchTerms(profile, prefs);
  const providers = activeJobProviders();
  const errors: string[] = [];
  let found = 0;
  let created = 0;
  const location = prefs?.locations[0] ?? profile.location ?? null;
  const remoteOnly = (prefs?.work_modes.length ?? 0) > 0 && prefs!.work_modes.every((m) => m === "remoto");

  let step = 0;
  const total = providers.length * Math.max(1, terms.length) + 1;
  for (const provider of providers) {
    for (const term of terms.length ? terms : [""]) {
      step += 1;
      await ctx.progress(step, total, `Consultando ${provider.name}: ${term || "perfil"}`);
      let raws: RawJob[] = [];
      try {
        raws = (await provider.search({ terms: [term, ...profile.skills.slice(0, 2)].filter(Boolean), location, remoteOnly, perPage: 30 })).jobs;
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        errors.push(`${provider.name}: ${err instanceof Error ? err.message : "falha"}`);
        continue;
      }
      for (const raw of raws) {
        found += 1;
        try {
          const { created: isNew } = await upsertJobFromRaw(owner, raw);
          if (isNew) created += 1;
        } catch (err) {
          if (!(err instanceof UniqueViolationError)) errors.push(`${raw.company}: ${err instanceof Error ? err.message : "falha"}`);
        }
      }
    }
  }
  await ctx.progress(total, total, "Calculando compatibilidade");
  const jobs = await repo.list(owner, "jobs");
  for (const j of jobs) await recomputeMatch(owner, profile, prefs, j);
  return { found, created, errors };
}

registerHandler("search_jobs", async (job, ctx) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const profile = (await repo.list(owner, "profiles"))[0];
  if (!profile) return;
  const prefs = await repo.get(owner, "preferences", owner.owner_id);
  const result = await runSearch(owner, profile, prefs, ctx);
  await ctx.progress(1, 1, `${result.found} anúncio(s) lidos, ${result.created} novo(s)${result.errors.length ? ` · ${result.errors.join("; ")}` : ""}`);
  if (result.found === 0 && result.errors.length) throw new Error(result.errors.join("; "));
});

/* ------------------------------------------------------------------ */
/* campaign_tick                                                       */
/* ------------------------------------------------------------------ */

async function createApplication(owner: Owner, campaign: ApplicationCampaign, profile: CareerProfile, job: JobPosting, match: JobMatch | null, prefs: CareerPreferences | null): Promise<JobApplication | null> {
  const repo = careerRepo();
  const channel = resolveChannel(campaign.channel, job);
  const templates = { subject: campaign.template_subject || defaultTemplates(job.language).subject, body: campaign.template_body || defaultTemplates(job.language).body };
  let subject: string;
  let body_text: string;
  let body_html: string;
  const rendered = renderApplicationMessage(templates, profile, job, match);
  subject = rendered.subject;
  body_text = rendered.body_text;
  body_html = rendered.body_html;
  const ai = await aiWriteApplication(profile, job, match, templates, job.language === "en" ? "inglês" : job.language === "es" ? "espanhol" : "português do Brasil");
  if (ai) {
    subject = sanitizeHeader(ai.output.subject, 150);
    body_text = ai.output.body;
    body_html = textToHtml(body_text);
  }
  const app: JobApplication = {
    id: uid("app"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    campaign_id: campaign.id,
    job_id: job.id,
    canonical_key: job.canonical_key,
    profile_id: profile.id,
    resume_version_id: campaign.resume_version_id,
    match_score: match?.score ?? null,
    channel,
    recipient: channel === "manual" ? null : job.application_email,
    subject,
    body_text,
    body_html,
    job_snapshot: { title: job.title, company: job.company, url: job.url, description_excerpt: job.description.slice(0, 600) },
    processing_status: channel === "manual" ? "acao_manual" : "enfileirada",
    email_status: null,
    selection_status: "registrada",
    provider_message_id: null,
    idempotency_key: `app_${uid()}`,
    attempts_count: 0,
    last_error: null,
    manual_apply_url: channel === "manual" ? job.apply_url ?? job.url : null,
    sent_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  void prefs;
  try {
    await repo.insert("applications", app);
  } catch (err) {
    if (err instanceof UniqueViolationError) return null; // já candidatado (outra campanha/canal)
    throw err;
  }
  await appendEvent(owner, app.id, channel === "manual" ? "acao_manual" : "enfileirada", "sistema", channel === "manual" ? "Anúncio sem e-mail de candidatura publicado; pacote preparado para envio manual" : `Enfileirada para envio via ${channel}`);
  if (channel !== "manual") await enqueue(owner, "send_application", { application_id: app.id }, { dedupe: true });
  return app;
}

registerHandler("campaign_tick", async (job, ctx) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const campaign = await repo.get(owner, "campaigns", String(job.payload.campaign_id));
  if (!campaign || campaign.status !== "ativa") return;
  if (campaign.ends_at && Date.parse(campaign.ends_at) < Date.now()) {
    await repo.update(owner, "campaigns", campaign.id, { status: "concluida", updated_at: nowIso() });
    return;
  }
  const profile = await repo.get(owner, "profiles", campaign.profile_id);
  if (!profile) return;
  const prefs = await repo.get(owner, "preferences", owner.owner_id);
  const today = new Date().toISOString().slice(0, 10);
  let sentToday = campaign.sent_day === today ? campaign.sent_today : 0;

  await ctx.progress(0, 3, "Selecionando vagas");
  const applied = new Set((await repo.list(owner, "applications")).filter((a) => a.processing_status !== "cancelada").map((a) => a.canonical_key));
  let candidates: JobPosting[] = [];
  if (campaign.recurring) {
    await runSearch(owner, profile, prefs, ctx, campaign.roles);
    const matches = await repo.list(owner, "matches");
    const jobs = await repo.list(owner, "jobs");
    candidates = jobs
      .filter((j) => j.status !== "encerrada" && !applied.has(j.canonical_key))
      .map((j) => ({ j, m: matches.find((m) => m.job_id === j.id) }))
      .filter(({ m }) => m && !m.dismissed && m.blocked_by.length === 0 && m.score >= campaign.min_score)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map(({ j }) => j);
  }
  for (const id of campaign.job_ids) {
    const j = await repo.get(owner, "jobs", id);
    if (j && !applied.has(j.canonical_key) && !candidates.some((c) => c.id === j.id)) candidates.push(j);
  }

  await ctx.progress(1, 3, `${candidates.length} vaga(s) elegível(is)`);
  const matches = await repo.list(owner, "matches");
  let createdNow = 0;
  for (const jobPosting of candidates) {
    if (sentToday >= campaign.daily_limit) break;
    // Relê o estado: pausa/cancelamento durante o laço interrompe novas candidaturas.
    const fresh = await repo.get(owner, "campaigns", campaign.id);
    if (!fresh || fresh.status !== "ativa") break;
    const match = matches.find((m) => m.job_id === jobPosting.id) ?? null;
    const app = await createApplication(owner, fresh, profile, jobPosting, match, prefs);
    if (app) {
      createdNow += 1;
      sentToday += 1;
      applied.add(jobPosting.canonical_key);
    }
  }
  await repo.update(owner, "campaigns", campaign.id, { sent_today: sentToday, sent_day: today, last_run_at: nowIso(), updated_at: nowIso() });
  await ctx.progress(2, 3, `${createdNow} candidatura(s) criada(s)`);

  if (campaign.recurring) {
    const next = new Date(Date.now() + RECURRING_INTERVAL_MS);
    await repo.update(owner, "campaigns", campaign.id, { next_run_at: next.toISOString() });
    ctx.reschedule(next);
  } else {
    const remaining = campaign.job_ids.filter((id) => !applied.has(candidates.find((c) => c.id === id)?.canonical_key ?? ""));
    if (remaining.length === 0 || sentToday < campaign.daily_limit) {
      await repo.update(owner, "campaigns", campaign.id, { status: "concluida", next_run_at: null, updated_at: nowIso() });
    } else {
      // Cota diária esgotada com vagas pendentes: volta amanhã.
      const next = new Date();
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(9, 0, 0, 0);
      await repo.update(owner, "campaigns", campaign.id, { next_run_at: next.toISOString() });
      ctx.reschedule(next);
    }
  }
  await ctx.progress(3, 3, "Ciclo concluído");
});

/* ------------------------------------------------------------------ */
/* send_application                                                    */
/* ------------------------------------------------------------------ */

/** Injeção para testes: substitui o canal real por um duplo. */
let channelOverride: ((app: JobApplication) => EmailChannel | null) | null = null;
export function setEmailChannelOverrideForTests(fn: ((app: JobApplication) => EmailChannel | null) | null) {
  channelOverride = fn;
}

async function channelFor(owner: Owner, app: JobApplication): Promise<EmailChannel | { error: string }> {
  const repo = careerRepo();
  const injected = channelOverride?.(app);
  if (injected) return injected;
  if (app.channel === "resend") {
    const ch = new ResendChannel();
    return ch.isConfigured() ? ch : { error: "Resend não configurado" };
  }
  if (app.channel === "gmail") {
    const conn = (await repo.list(owner, "connections", { provider: "gmail" }))[0];
    if (!conn || conn.status !== "ativa") return { error: "Conta Gmail desconectada" };
    return new GmailChannel(conn, async (patch) => {
      await repo.update(owner, "connections", conn.id, patch);
    });
  }
  return { error: "Canal sem envio automático" };
}

registerHandler("send_application", async (job) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const app = await repo.get(owner, "applications", String(job.payload.application_id));
  if (!app) return;
  if (!["enfileirada", "pendente", "resultado_incerto", "processando"].includes(app.processing_status)) return;

  // Estado da campanha conferido imediatamente antes de qualquer chamada externa.
  const campaign = app.campaign_id ? await repo.get(owner, "campaigns", app.campaign_id) : null;
  if (campaign && campaign.status === "pausada") {
    await repo.update(owner, "applications", app.id, { processing_status: "pendente", updated_at: nowIso() });
    await appendEvent(owner, app.id, "pausada", "sistema", "Campanha pausada: envio adiado");
    return;
  }
  if (campaign && (campaign.status === "cancelada")) {
    await repo.update(owner, "applications", app.id, { processing_status: "cancelada", updated_at: nowIso() });
    await appendEvent(owner, app.id, "cancelada", "sistema", "Campanha cancelada antes do envio");
    return;
  }

  // Revalida a vaga antes de enviar: anúncio fora do ar não recebe candidatura.
  const posting = await repo.get(owner, "jobs", app.job_id);
  if (posting) {
    const provider = getJobProvider(posting.source);
    const available = provider ? await provider.checkAvailability(posting.external_id, posting.url) : null;
    if (available === false) {
      await repo.update(owner, "jobs", posting.id, { status: "encerrada", status_checked_at: nowIso() });
      await repo.update(owner, "applications", app.id, { processing_status: "cancelada", last_error: "Anúncio encerrado antes do envio", updated_at: nowIso() });
      await appendEvent(owner, app.id, "cancelada", "sistema", "Anúncio não está mais disponível na fonte");
      return;
    }
    if (available !== null) await repo.update(owner, "jobs", posting.id, { status_checked_at: nowIso() });
  }

  const recipient = app.recipient;
  if (!recipient || !isValidEmail(recipient)) {
    await repo.update(owner, "applications", app.id, { processing_status: "falhou", last_error: "Destinatário inválido", updated_at: nowIso() });
    await appendEvent(owner, app.id, "falhou", "sistema", "Destinatário inválido — não há para onde enviar");
    return;
  }
  const channel = await channelFor(owner, app);
  if ("error" in channel) {
    await repo.update(owner, "applications", app.id, { processing_status: "falhou", last_error: channel.error, updated_at: nowIso() });
    await appendEvent(owner, app.id, "falhou", "sistema", channel.error);
    return;
  }
  const file = await getFile((await repo.get(owner, "resumes", app.resume_version_id))?.storage_key ?? "");
  const version = await repo.get(owner, "resumes", app.resume_version_id);
  if (!file || !version) {
    await repo.update(owner, "applications", app.id, { processing_status: "falhou", last_error: "Currículo indisponível", updated_at: nowIso() });
    await appendEvent(owner, app.id, "falhou", "sistema", "Arquivo do currículo não encontrado");
    return;
  }
  const prefs = await repo.get(owner, "preferences", owner.owner_id);

  // Intenção registrada antes da chamada externa; a chave de idempotência é a mesma em todos os retries.
  const number = app.attempts_count + 1;
  const attempt: ApplicationAttempt = {
    id: uid("att"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    application_id: app.id,
    number,
    idempotency_key: app.idempotency_key,
    channel: app.channel,
    outcome: "incerto",
    provider_message_id: null,
    error: null,
    started_at: nowIso(),
    finished_at: null,
  };
  await repo.insert("attempts", attempt);
  await repo.update(owner, "applications", app.id, { processing_status: "processando", attempts_count: number, updated_at: nowIso() });

  const outcome: SendOutcome = await channel.send({
    to: recipient,
    subject: app.subject,
    text: app.body_text,
    html: app.body_html,
    replyTo: app.channel === "resend" ? prefs?.candidate_email ?? null : null,
    attachment: { filename: version.file_name || "curriculo.pdf", content: file, contentType: "application/pdf" },
    idempotencyKey: app.idempotency_key,
    applicationId: app.id,
  });

  const finishAttempt = (patch: Partial<ApplicationAttempt>) => repo.update(owner, "attempts", attempt.id, { ...patch, finished_at: nowIso() });

  if (outcome.kind === "accepted") {
    await finishAttempt({ outcome: "sucesso", provider_message_id: outcome.providerMessageId });
    await repo.update(owner, "applications", app.id, {
      processing_status: "concluida",
      email_status: "aceito",
      provider_message_id: outcome.providerMessageId,
      sent_at: nowIso(),
      last_error: null,
      updated_at: nowIso(),
    });
    await appendEvent(owner, app.id, "email:aceito", "provedor", `Aceito por ${channel.name} (id ${outcome.providerMessageId})`);
    return;
  }
  if (outcome.kind === "rate_limited") {
    await finishAttempt({ outcome: "falha", error: "Limite do provedor (429)" });
    await repo.update(owner, "applications", app.id, { processing_status: "enfileirada", last_error: "Limite do provedor; nova tentativa agendada", updated_at: nowIso() });
    throw new RateLimitedError(outcome.retryAfterMs);
  }
  if (outcome.kind === "uncertain") {
    await finishAttempt({ outcome: "incerto", error: outcome.error });
    await repo.update(owner, "applications", app.id, { processing_status: "resultado_incerto", last_error: outcome.error, updated_at: nowIso() });
    await appendEvent(owner, app.id, "resultado_incerto", "sistema", `Sem resposta do provedor após o envio (${outcome.error}). ${app.channel === "resend" ? "Reconciliação automática com a mesma chave de idempotência em 2 min." : "Confira a pasta Enviados da conta Gmail e reenvie manualmente se necessário."}`);
    if (app.channel === "resend" && number < 3) {
      await enqueue(owner, "send_application", { application_id: app.id, reconcile: number }, { runAt: new Date(Date.now() + 120_000), maxAttempts: 1 });
    }
    return;
  }
  // rejected
  await finishAttempt({ outcome: "falha", error: outcome.error });
  if (outcome.permanent || number >= 3) {
    await repo.update(owner, "applications", app.id, { processing_status: "falhou", last_error: outcome.error, updated_at: nowIso() });
    await appendEvent(owner, app.id, "falhou", "provedor", outcome.error);
    return;
  }
  await repo.update(owner, "applications", app.id, { processing_status: "enfileirada", last_error: outcome.error, updated_at: nowIso() });
  throw new Error(outcome.error); // falha transitória: o backoff da fila reagenda
});

/* ------------------------------------------------------------------ */
/* recheck_job                                                         */
/* ------------------------------------------------------------------ */

registerHandler("recheck_job", async (job) => {
  const owner = ownerOfJob(job);
  const repo = careerRepo();
  const posting = await repo.get(owner, "jobs", String(job.payload.job_id));
  if (!posting) return;
  const provider = getJobProvider(posting.source);
  const available = provider ? await provider.checkAvailability(posting.external_id, posting.url) : null;
  await repo.update(owner, "jobs", posting.id, { status: available === false ? "encerrada" : available === true ? "aberta" : posting.status, status_checked_at: nowIso() });
});
