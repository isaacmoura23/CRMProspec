import "server-only";
// Registra os handlers da fila junto com o serviço: quem enfileira também garante quem executa.
import "@/services/career/handlers";
import { uid } from "@/lib/utils";
import { isLlmConfigured } from "@/ai/client";
import { csvCell, isValidEmail } from "@/lib/job-text";
import { isTokenSecretConfigured } from "@/lib/crypto";
import { validatePublicUrl } from "@/lib/safe-url";
import { activeJobProviders, jobSourcesStatus, type JobSourceStatus } from "@/providers/jobs/registry";
import { importJobFromUrl } from "@/providers/jobs/url-import";
import { gmailConfigProblem } from "@/providers/email/gmail";
import { resendConfigProblem } from "@/providers/email/resend";
import { getOcrProvider } from "@/providers/ocr";
import { extractProfileHeuristic } from "@/services/career/analysis-engine";
import { buildStorageKey, createDownloadUrl, createUploadTarget, deleteFile, getFile, putFile, storageMode } from "@/services/career/files";
import { computeMatch } from "@/services/career/matching";
import { defaultTemplates, renderApplicationMessage } from "@/services/career/messaging";
import { extractResume, sha256, validatePdfBytes, MAX_PDF_BYTES } from "@/services/career/pdf";
import { cancelPendingJobs, enqueue, kickWorker } from "@/services/career/queue";
import { careerRepo, UniqueViolationError, type Owner } from "@/services/career/repository";
import { jobCanonicalKey, detectLanguage } from "@/lib/job-text";
import type { RawJob } from "@/providers/jobs/types";
import type { User } from "@/types";
import type {
  ApplicationCampaign,
  ApplicationEvent,
  CareerJob,
  CareerPreferences,
  CareerProfile,
  JobApplication,
  JobMatch,
  JobPosting,
  LinkCheck,
  ProviderConnection,
  ResumeAnalysis,
  ResumeVersion,
  SelectionStatus,
  ApplicationChannel,
} from "@/types/career";

/**
 * Serviço de domínio do módulo Carreira. Toda função recebe o `Owner`
 * resolvido a partir da sessão do servidor; nada aqui aceita owner_id do
 * cliente.
 */

export function ownerOf(user: User): Owner {
  return { owner_id: user.id, organization_id: user.organization_id };
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Configuração visível na interface                                   */
/* ------------------------------------------------------------------ */

export interface CareerConfigStatus {
  storage: "supabase" | "local";
  llm: boolean;
  ocr: { configured: boolean; name: string; maxBytes: number; maxPages: number };
  resend: { configured: boolean; problem: string | null };
  gmail: { oauthConfigured: boolean; problem: string | null; connection: { email: string; status: ProviderConnection["status"] } | null };
  tokenSecret: boolean;
  jobSources: JobSourceStatus[];
  demoAuth: boolean;
  maxPdfBytes: number;
}

export async function careerConfigStatus(owner: Owner): Promise<CareerConfigStatus> {
  const ocr = getOcrProvider();
  const connections = await careerRepo().list(owner, "connections", { provider: "gmail" });
  const conn = connections[0] ?? null;
  return {
    storage: storageMode(),
    llm: isLlmConfigured(),
    ocr: { configured: ocr.isConfigured(), name: ocr.name, maxBytes: ocr.maxBytes, maxPages: ocr.maxPages },
    resend: { configured: resendConfigProblem() === null, problem: resendConfigProblem() },
    gmail: { oauthConfigured: gmailConfigProblem() === null, problem: gmailConfigProblem(), connection: conn ? { email: conn.account_email, status: conn.status } : null },
    tokenSecret: isTokenSecretConfigured(),
    jobSources: jobSourcesStatus(),
    demoAuth: !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    maxPdfBytes: MAX_PDF_BYTES,
  };
}

/* ------------------------------------------------------------------ */
/* Currículos                                                          */
/* ------------------------------------------------------------------ */

export async function prepareResumeUpload(owner: Owner, fileName: string, sizeBytes: number) {
  if (sizeBytes > MAX_PDF_BYTES) throw new Error(`O arquivo excede ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB.`);
  if (!/\.pdf$/i.test(fileName)) throw new Error("Envie um arquivo PDF.");
  const versionId = uid("cv");
  const key = buildStorageKey(owner.owner_id, versionId);
  const version: ResumeVersion = {
    id: versionId,
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    kind: "original",
    label: fileName.replace(/\.pdf$/i, "").slice(0, 80),
    source_version_id: null,
    file_name: fileName.slice(0, 120),
    storage_key: key,
    size_bytes: sizeBytes,
    sha256: "",
    page_count: null,
    text_status: "pendente",
    text_note: "Aguardando o arquivo",
    pages: [],
    links: [],
    created_at: nowIso(),
  };
  await careerRepo().insert("resumes", version);
  const target = await createUploadTarget(key);
  return { versionId, target };
}

/** Caminho do modo local: o route handler recebe os bytes e grava. */
export async function storeUploadedResume(owner: Owner, versionId: string, bytes: Uint8Array) {
  const repo = careerRepo();
  const version = await repo.get(owner, "resumes", versionId);
  if (!version) throw new Error("Versão de currículo não encontrada.");
  const check = validatePdfBytes(bytes);
  if (!check.ok) {
    await repo.remove(owner, "resumes", { id: versionId });
    throw new Error(check.reason);
  }
  await putFile(version.storage_key, bytes);
  return finalizeResumeUpload(owner, versionId);
}

/**
 * Valida o objeto já armazenado (tamanho, assinatura, parser), calcula o
 * hash, deduplica contra versões anteriores, extrai texto/links e cria o
 * perfil se ainda não existir. A análise em si vai para a fila.
 */
export async function finalizeResumeUpload(owner: Owner, versionId: string): Promise<{ version: ResumeVersion; duplicateOf: string | null }> {
  const repo = careerRepo();
  const version = await repo.get(owner, "resumes", versionId);
  if (!version) throw new Error("Versão de currículo não encontrada.");
  const bytes = await getFile(version.storage_key);
  if (!bytes) {
    await repo.remove(owner, "resumes", { id: versionId });
    throw new Error("O arquivo não chegou ao armazenamento. Tente novamente.");
  }
  const check = validatePdfBytes(bytes);
  if (!check.ok) {
    await deleteFile(version.storage_key);
    await repo.remove(owner, "resumes", { id: versionId });
    throw new Error(check.reason);
  }
  const hash = sha256(bytes);
  const existing = (await repo.list(owner, "resumes")).find((r) => r.sha256 === hash && r.id !== versionId);
  if (existing) {
    await deleteFile(version.storage_key);
    await repo.remove(owner, "resumes", { id: versionId });
    return { version: existing, duplicateOf: existing.id };
  }

  const extracted = await extractResume(bytes);
  const updated = await repo.update(owner, "resumes", versionId, {
    sha256: hash,
    size_bytes: bytes.byteLength,
    page_count: extracted.page_count,
    text_status: extracted.text_status,
    text_note: extracted.text_note,
    pages: extracted.pages,
    links: extracted.links,
  });
  if (!updated) throw new Error("Falha ao registrar o currículo.");

  if (extracted.text_status === "ocr_pendente") {
    const ocr = getOcrProvider();
    if (!ocr.isConfigured()) {
      await repo.update(owner, "resumes", versionId, {
        text_status: "ocr_indisponivel",
        text_note: `O PDF parece digitalizado e o OCR não está configurado (OCR_SPACE_API_KEY). Exporte o currículo como PDF de texto ou configure o OCR.`,
      });
    } else if (bytes.byteLength > ocr.maxBytes || (extracted.page_count ?? 0) > ocr.maxPages) {
      await repo.update(owner, "resumes", versionId, {
        text_status: "ocr_indisponivel",
        text_note: `O PDF parece digitalizado e excede os limites do OCR configurado (${Math.round(ocr.maxBytes / 1024)} KB, ${ocr.maxPages} páginas).`,
      });
    }
  }

  const readable = extracted.text_status === "ok" || extracted.text_status === "parcial" || extracted.text_status === "ocr_pendente";
  if (readable) {
    await ensureProfileFromVersion(owner, { ...updated, pages: extracted.pages, links: extracted.links });
    await enqueue(owner, "analyze_resume", { resume_version_id: versionId });
    kickWorker();
  }
  const final = (await repo.get(owner, "resumes", versionId)) ?? updated;
  return { version: final, duplicateOf: null };
}

async function ensureProfileFromVersion(owner: Owner, version: ResumeVersion): Promise<CareerProfile> {
  const repo = careerRepo();
  const existing = (await repo.list(owner, "profiles"))[0];
  const draft = extractProfileHeuristic(version.pages, version.links);
  if (existing) {
    // Perfil confirmado pelo titular não é sobrescrito por uma nova versão;
    // só os links e a referência da versão são atualizados.
    const patch: Partial<CareerProfile> = existing.confirmed
      ? { resume_version_id: version.id, links: [...new Set([...existing.links, ...draft.links])], updated_at: nowIso() }
      : { ...draft, resume_version_id: version.id, updated_at: nowIso() };
    return (await repo.update(owner, "profiles", existing.id, patch)) ?? existing;
  }
  const profile: CareerProfile = {
    id: uid("cp"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    resume_version_id: version.id,
    ...draft,
    confirmed: false,
    extraction_model: "engine/heuristic-v1",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  return repo.insert("profiles", profile);
}

export async function deleteResumeVersion(owner: Owner, versionId: string) {
  const repo = careerRepo();
  const version = await repo.get(owner, "resumes", versionId);
  if (!version) return;
  const inUse = (await repo.list(owner, "campaigns")).some((c) => c.resume_version_id === versionId && (c.status === "ativa" || c.status === "pausada"));
  if (inUse) throw new Error("Esta versão está em uso por uma campanha ativa. Pause ou cancele a campanha antes.");
  await cancelPendingJobs(owner, (j) => j.payload.resume_version_id === versionId);
  await deleteFile(version.storage_key);
  await repo.remove(owner, "analyses", { resume_version_id: versionId });
  await repo.remove(owner, "link_checks", { resume_version_id: versionId });
  await repo.remove(owner, "resumes", { id: versionId });
}

export async function resumeDownloadUrl(owner: Owner, versionId: string): Promise<string | null> {
  const version = await careerRepo().get(owner, "resumes", versionId);
  return version ? createDownloadUrl(version.storage_key, version.id) : null;
}

export async function resumeBytes(owner: Owner, versionId: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const version = await careerRepo().get(owner, "resumes", versionId);
  if (!version) return null;
  const bytes = await getFile(version.storage_key);
  return bytes ? { bytes, fileName: version.file_name } : null;
}

/* ------------------------------------------------------------------ */
/* Perfil e preferências                                               */
/* ------------------------------------------------------------------ */

export async function updateProfile(owner: Owner, patch: Partial<CareerProfile>): Promise<CareerProfile | null> {
  const repo = careerRepo();
  const existing = (await repo.list(owner, "profiles"))[0];
  if (!existing) return null;
  const { id: _id, owner_id: _o, organization_id: _org, created_at: _c, ...safe } = patch;
  void _id; void _o; void _org; void _c;
  return repo.update(owner, "profiles", existing.id, { ...safe, updated_at: nowIso() });
}

export function defaultPreferences(owner: Owner, profile: CareerProfile | null): CareerPreferences {
  return {
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    desired_roles: profile?.headline ? [profile.headline] : [],
    locations: profile?.location ? [profile.location] : [],
    work_modes: [],
    languages: profile?.languages ?? [],
    contract_types: [],
    min_salary: null,
    currency: "BRL",
    excluded_companies: [],
    min_match_score: 60,
    candidate_email: profile?.email && isValidEmail(profile.email) ? profile.email : null,
    updated_at: nowIso(),
  };
}

export async function savePreferences(owner: Owner, input: Omit<CareerPreferences, "owner_id" | "organization_id" | "updated_at">): Promise<CareerPreferences> {
  const repo = careerRepo();
  const prefs: CareerPreferences = { ...input, owner_id: owner.owner_id, organization_id: owner.organization_id, updated_at: nowIso() };
  const existing = await repo.get(owner, "preferences", owner.owner_id);
  if (existing) return (await repo.update(owner, "preferences", owner.owner_id, prefs)) ?? prefs;
  return repo.insert("preferences", prefs);
}

/* ------------------------------------------------------------------ */
/* Análise e sugestões                                                 */
/* ------------------------------------------------------------------ */

export async function requestAnalysis(owner: Owner, versionId: string) {
  const version = await careerRepo().get(owner, "resumes", versionId);
  if (!version) throw new Error("Versão não encontrada.");
  if (!["ok", "parcial", "ocr_pendente"].includes(version.text_status)) throw new Error("Esta versão não tem texto legível para análise.");
  await enqueue(owner, "analyze_resume", { resume_version_id: versionId, force: true }, { dedupe: true });
  kickWorker();
}

export async function setSuggestionStatus(owner: Owner, analysisId: string, suggestionId: string, status: "pendente" | "aceita" | "rejeitada", edited: string | null) {
  const repo = careerRepo();
  const analysis = await repo.get(owner, "analyses", analysisId);
  if (!analysis) throw new Error("Análise não encontrada.");
  const suggestions = analysis.suggestions.map((s) => (s.id === suggestionId ? { ...s, status, edited: edited?.trim() || null } : s));
  await repo.update(owner, "analyses", analysisId, { suggestions });
}

/**
 * Gera a versão revisada: aplica as sugestões aceitas sobre o texto e
 * produz um PDF simples, de texto selecionável (pdf-lib). O original é
 * preservado como outra versão.
 */
export async function generateRevisedResume(owner: Owner, analysisId: string): Promise<ResumeVersion> {
  const repo = careerRepo();
  const analysis = await repo.get(owner, "analyses", analysisId);
  if (!analysis) throw new Error("Análise não encontrada.");
  const source = await repo.get(owner, "resumes", analysis.resume_version_id);
  if (!source) throw new Error("Versão de origem não encontrada.");
  const accepted = analysis.suggestions.filter((s) => s.status === "aceita");
  if (accepted.length === 0) throw new Error("Aceite ao menos uma sugestão antes de gerar a versão revisada.");

  const pages = source.pages.map((p) => {
    let text = p.text;
    for (const s of accepted) {
      const replacement = (s.edited ?? s.suggested).trim();
      if (!replacement || /\[[^\]]+\]/.test(replacement)) continue; // ainda tem lacuna a preencher
      text = text.split(s.original).join(replacement);
    }
    return { page: p.page, text };
  });

  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10.5;
  const lineHeight = 14;
  const margin = 50;
  const width = 595.28; // A4
  const height = 841.89;
  const maxWidth = width - margin * 2;
  let page = doc.addPage([width, height]);
  let y = height - margin;

  const sanitize = (s: string) => s.replace(/[^\x00-\xff]/g, (ch) => (/[‘’]/.test(ch) ? "'" : /[“”]/.test(ch) ? '"' : /[–—]/.test(ch) ? "-" : /•/.test(ch) ? "-" : "?"));
  const wrap = (line: string): string[] => {
    const words = line.split(" ");
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > maxWidth && cur) {
        out.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) out.push(cur);
    return out;
  };
  for (const p of pages) {
    for (const raw of p.text.split(/\n/)) {
      const lines = raw.trim() ? wrap(sanitize(raw)) : [""];
      for (const l of lines) {
        if (y < margin) {
          page = doc.addPage([width, height]);
          y = height - margin;
        }
        if (l) page.drawText(l, { x: margin, y, size, font });
        y -= lineHeight;
      }
    }
    y -= lineHeight; // separação entre páginas de origem
  }
  const bytes = await doc.save();

  const versionId = uid("cv");
  const key = buildStorageKey(owner.owner_id, versionId);
  await putFile(key, bytes);
  const version: ResumeVersion = {
    id: versionId,
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    kind: "revisada",
    label: `${source.label} — revisada`,
    source_version_id: source.id,
    file_name: source.file_name.replace(/\.pdf$/i, "") + "-revisado.pdf",
    storage_key: key,
    size_bytes: bytes.byteLength,
    sha256: sha256(bytes),
    page_count: doc.getPageCount(),
    text_status: "ok",
    text_note: `Gerada a partir de ${accepted.length} sugestão(ões) aceita(s). Layout simples, texto selecionável.`,
    pages,
    links: source.links,
    created_at: nowIso(),
  };
  return repo.insert("resumes", version);
}

/* ------------------------------------------------------------------ */
/* Vagas                                                               */
/* ------------------------------------------------------------------ */

export function buildSearchTerms(profile: CareerProfile, prefs: CareerPreferences | null): string[] {
  const roles = (prefs?.desired_roles ?? []).filter(Boolean);
  const base = roles.length ? roles : profile.headline ? [profile.headline] : profile.experiences.slice(0, 2).map((e) => e.role).filter(Boolean);
  return [...new Set(base.map((s) => s.trim()).filter(Boolean))].slice(0, 4);
}

export async function upsertJobFromRaw(owner: Owner, raw: RawJob): Promise<{ job: JobPosting; created: boolean }> {
  const repo = careerRepo();
  const canonical_key = jobCanonicalKey({ company: raw.company, title: raw.title, location: raw.location, url: raw.url });
  const existing = (await repo.list(owner, "jobs", { canonical_key }))[0];
  const { required } = (await import("@/lib/job-text")).extractRequirements(raw.description);
  const fields = {
    title: raw.title,
    company: raw.company,
    description: raw.description,
    requirements: required,
    location: raw.location,
    work_mode: raw.work_mode,
    url: raw.url,
    apply_url: raw.apply_url,
    application_email: raw.application_email && isValidEmail(raw.application_email) ? raw.application_email : null,
    application_email_evidence: raw.application_email_evidence,
    salary: raw.salary,
    contract_type: raw.contract_type,
    language: detectLanguage(raw.description),
    posted_at: raw.posted_at,
    expires_at: raw.expires_at,
  };
  if (existing) {
    // Mantém a primeira fonte como origem, mas atualiza dados que a nova traz.
    const updated = await repo.update(owner, "jobs", existing.id, { ...fields, collected_at: nowIso(), status: existing.status === "encerrada" ? "encerrada" : "aberta" });
    return { job: updated ?? existing, created: false };
  }
  const job: JobPosting = {
    id: uid("job"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    source: raw.source,
    external_id: raw.external_id,
    canonical_key,
    ...fields,
    collected_at: nowIso(),
    status: "aberta",
    status_checked_at: null,
    origin_evidence: raw.origin_evidence,
  };
  try {
    return { job: await repo.insert("jobs", job), created: true };
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      const dup = (await repo.list(owner, "jobs", { canonical_key }))[0];
      if (dup) return { job: dup, created: false };
    }
    throw err;
  }
}

export async function recomputeMatch(owner: Owner, profile: CareerProfile, prefs: CareerPreferences | null, job: JobPosting): Promise<JobMatch> {
  const repo = careerRepo();
  const computed = computeMatch(profile, prefs, job);
  const existing = (await repo.list(owner, "matches", { job_id: job.id }))[0];
  if (existing) {
    return (await repo.update(owner, "matches", existing.id, { ...computed, profile_id: profile.id, computed_at: nowIso() })) ?? existing;
  }
  const match: JobMatch = {
    id: uid("mt"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    job_id: job.id,
    profile_id: profile.id,
    ...computed,
    saved: false,
    dismissed: false,
    computed_at: nowIso(),
  };
  return repo.insert("matches", match);
}

export async function importJob(owner: Owner, url: string): Promise<{ job: JobPosting; match: JobMatch | null } | { error: string }> {
  const check = validatePublicUrl(url);
  if (!check.ok) return { error: check.reason };
  const result = await importJobFromUrl(check.url.toString());
  if ("error" in result) return result;
  const { job } = await upsertJobFromRaw(owner, result.job);
  const repo = careerRepo();
  const profile = (await repo.list(owner, "profiles"))[0] ?? null;
  const prefs = await repo.get(owner, "preferences", owner.owner_id);
  const match = profile ? await recomputeMatch(owner, profile, prefs, job) : null;
  return { job, match };
}

export async function requestJobSearch(owner: Owner): Promise<{ error?: string; job?: CareerJob }> {
  const repo = careerRepo();
  const profile = (await repo.list(owner, "profiles"))[0];
  if (!profile) return { error: "Envie um currículo antes de buscar vagas." };
  if (activeJobProviders().length === 0) {
    return { error: "Nenhuma fonte de vagas configurada. Configure uma fonte em Integrações ou importe uma vaga pela URL." };
  }
  const job = await enqueue(owner, "search_jobs", { trigger: "manual" }, { dedupe: true });
  kickWorker();
  return { job };
}

/* ------------------------------------------------------------------ */
/* Campanhas e candidaturas                                            */
/* ------------------------------------------------------------------ */

export interface CampaignInput {
  name: string;
  job_ids: string[];
  recurring: boolean;
  roles: string[];
  min_score: number;
  resume_version_id: string;
  channel: ApplicationChannel;
  daily_limit: number;
  ends_at: string | null;
  template_subject: string;
  template_body: string;
}

export interface CampaignPreview {
  job: JobPosting;
  match: JobMatch | null;
  subject: string;
  body_text: string;
  recipient: string | null;
  channel: ApplicationChannel;
  note: string | null;
}

export async function previewCampaign(owner: Owner, input: CampaignInput): Promise<{ previews: CampaignPreview[]; warnings: string[] }> {
  const repo = careerRepo();
  const profile = (await repo.list(owner, "profiles"))[0];
  if (!profile) throw new Error("Perfil não encontrado.");
  const warnings: string[] = [];
  if (!profile.confirmed) warnings.push("O perfil ainda não foi confirmado. Revise a extração antes de ativar envios.");
  const jobs = (await Promise.all(input.job_ids.map((id) => repo.get(owner, "jobs", id)))).filter((j): j is JobPosting => Boolean(j));
  const matches = await repo.list(owner, "matches");
  const previews: CampaignPreview[] = [];
  for (const job of jobs.slice(0, 5)) {
    const match = matches.find((m) => m.job_id === job.id) ?? null;
    const templates = { subject: input.template_subject, body: input.template_body };
    let rendered: { subject: string; body_text: string };
    try {
      rendered = renderApplicationMessage(templates, profile, job, match);
    } catch (err) {
      rendered = { subject: "", body_text: "" };
      warnings.push(`Modelo inválido para ${job.company}: ${err instanceof Error ? err.message : "erro"}`);
    }
    const channel = resolveChannel(input.channel, job);
    previews.push({
      job,
      match,
      subject: rendered.subject,
      body_text: rendered.body_text,
      recipient: job.application_email,
      channel,
      note: channel === "manual" ? "Sem e-mail de candidatura publicado: será preparado o pacote para envio manual pelo link da vaga." : null,
    });
  }
  return { previews, warnings };
}

/** Sem e-mail publicado no anúncio não há para onde enviar: vira ação manual. */
export function resolveChannel(requested: ApplicationChannel, job: JobPosting): ApplicationChannel {
  if (requested === "manual") return "manual";
  return job.application_email ? requested : "manual";
}

export async function createCampaign(owner: Owner, input: CampaignInput): Promise<ApplicationCampaign> {
  const repo = careerRepo();
  const profile = (await repo.list(owner, "profiles"))[0];
  if (!profile) throw new Error("Perfil não encontrado.");
  if (!profile.confirmed) throw new Error("Confirme o perfil extraído antes de iniciar candidaturas.");
  const version = await repo.get(owner, "resumes", input.resume_version_id);
  if (!version) throw new Error("Versão do currículo não encontrada.");
  if (!input.recurring && input.job_ids.length === 0) throw new Error("Selecione ao menos uma vaga.");
  if (input.channel === "resend" && resendConfigProblem()) throw new Error(`Resend não está pronto: ${resendConfigProblem()}`);
  if (input.channel === "gmail") {
    const conn = (await repo.list(owner, "connections", { provider: "gmail" }))[0];
    if (!conn || conn.status !== "ativa") throw new Error("Conecte uma conta Gmail antes de usar este canal.");
  }
  const prefs = await repo.get(owner, "preferences", owner.owner_id);
  if (input.channel === "resend" && !(prefs?.candidate_email && isValidEmail(prefs.candidate_email))) {
    throw new Error("Informe e confirme seu e-mail nas preferências: ele será o endereço de resposta (reply-to).");
  }
  // Valida o modelo com dados reais antes de ativar.
  const sampleJob = input.job_ids.length ? await repo.get(owner, "jobs", input.job_ids[0]!) : null;
  if (sampleJob) renderApplicationMessage({ subject: input.template_subject, body: input.template_body }, profile, sampleJob, null);

  const now = nowIso();
  const campaign: ApplicationCampaign = {
    id: uid("cmp"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    name: input.name.trim() || `Campanha ${new Date().toLocaleDateString("pt-BR")}`,
    status: "ativa",
    job_ids: input.job_ids,
    recurring: input.recurring,
    roles: input.roles,
    min_score: input.min_score,
    resume_version_id: input.resume_version_id,
    profile_id: profile.id,
    channel: input.channel,
    daily_limit: Math.max(1, Math.min(200, input.daily_limit)),
    ends_at: input.ends_at,
    template_subject: input.template_subject,
    template_body: input.template_body,
    sent_today: 0,
    sent_day: null,
    next_run_at: now,
    last_run_at: null,
    created_at: now,
    updated_at: now,
  };
  await repo.insert("campaigns", campaign);
  await enqueue(owner, "campaign_tick", { campaign_id: campaign.id });
  kickWorker();
  return campaign;
}

export async function setCampaignStatus(owner: Owner, campaignId: string, status: "ativa" | "pausada" | "cancelada"): Promise<ApplicationCampaign | null> {
  const repo = careerRepo();
  const campaign = await repo.get(owner, "campaigns", campaignId);
  if (!campaign) return null;
  if (campaign.status === "cancelada" || campaign.status === "concluida") return campaign;
  const updated = await repo.update(owner, "campaigns", campaignId, { status, updated_at: nowIso(), next_run_at: status === "ativa" ? nowIso() : campaign.next_run_at });
  if (status === "cancelada") {
    // Candidaturas ainda não enviadas são canceladas; as enviadas ficam como estão.
    const apps = await repo.list(owner, "applications", { campaign_id: campaignId });
    for (const app of apps) {
      if (["pendente", "enfileirada", "rascunho"].includes(app.processing_status)) {
        await repo.update(owner, "applications", app.id, { processing_status: "cancelada", updated_at: nowIso() });
        await appendEvent(owner, app.id, "cancelada", "sistema", "Campanha cancelada pelo titular");
      }
    }
    await cancelPendingJobs(owner, (j) => j.kind === "campaign_tick" && j.payload.campaign_id === campaignId);
  }
  if (status === "ativa") {
    await enqueue(owner, "campaign_tick", { campaign_id: campaignId });
    kickWorker();
  }
  return updated;
}

export async function appendEvent(owner: Owner, applicationId: string, type: string, source: ApplicationEvent["source"], detail: string | null, extra: { provider_event_id?: string | null; occurred_at?: string } = {}) {
  const event: ApplicationEvent = {
    id: uid("ev"),
    owner_id: owner.owner_id,
    organization_id: owner.organization_id,
    application_id: applicationId,
    type,
    source,
    detail,
    provider_event_id: extra.provider_event_id ?? null,
    occurred_at: extra.occurred_at ?? nowIso(),
    created_at: nowIso(),
  };
  await careerRepo().insert("events", event);
}

export async function updateSelectionStatus(owner: Owner, applicationId: string, status: SelectionStatus, note: string | null) {
  const repo = careerRepo();
  const app = await repo.get(owner, "applications", applicationId);
  if (!app) throw new Error("Candidatura não encontrada.");
  await repo.update(owner, "applications", applicationId, { selection_status: status, updated_at: nowIso() });
  await appendEvent(owner, applicationId, `selecao:${status}`, "manual", note);
}

export async function markManualApplicationDone(owner: Owner, applicationId: string, note: string | null) {
  const repo = careerRepo();
  const app = await repo.get(owner, "applications", applicationId);
  if (!app) throw new Error("Candidatura não encontrada.");
  if (app.processing_status !== "acao_manual") throw new Error("Esta candidatura não está aguardando ação manual.");
  await repo.update(owner, "applications", applicationId, { processing_status: "concluida", sent_at: nowIso(), updated_at: nowIso() });
  await appendEvent(owner, applicationId, "concluida_manual", "manual", note ?? "Titular informou que concluiu a candidatura pelo site da vaga");
}

export async function retryApplication(owner: Owner, applicationId: string) {
  const repo = careerRepo();
  const app = await repo.get(owner, "applications", applicationId);
  if (!app) throw new Error("Candidatura não encontrada.");
  if (!["falhou", "resultado_incerto"].includes(app.processing_status)) throw new Error("Só candidaturas com falha ou resultado incerto podem ser reenviadas.");
  await repo.update(owner, "applications", applicationId, { processing_status: "enfileirada", updated_at: nowIso() });
  await appendEvent(owner, applicationId, "reenfileirada", "manual", "Reenvio solicitado pelo titular (mesma chave de idempotência)");
  await enqueue(owner, "send_application", { application_id: applicationId }, { dedupe: true, maxAttempts: 2 });
  kickWorker();
}

/* ------------------------------------------------------------------ */
/* Snapshot para a interface                                           */
/* ------------------------------------------------------------------ */

export interface CareerSnapshot {
  profile: CareerProfile | null;
  preferences: CareerPreferences;
  resumes: ResumeVersion[];
  analyses: ResumeAnalysis[];
  linkChecks: LinkCheck[];
  jobs: JobPosting[];
  matches: JobMatch[];
  campaigns: ApplicationCampaign[];
  applications: JobApplication[];
  events: ApplicationEvent[];
  activeJobs: CareerJob[];
  config: CareerConfigStatus;
  defaultTemplates: { subject: string; body: string };
}

export async function getCareerSnapshot(owner: Owner): Promise<CareerSnapshot> {
  const repo = careerRepo();
  const [profiles, prefs, resumes, analyses, linkChecks, jobs, matches, campaigns, applications, events, queue, config] = await Promise.all([
    repo.list(owner, "profiles"),
    repo.get(owner, "preferences", owner.owner_id),
    repo.list(owner, "resumes"),
    repo.list(owner, "analyses"),
    repo.list(owner, "link_checks"),
    repo.list(owner, "jobs"),
    repo.list(owner, "matches"),
    repo.list(owner, "campaigns"),
    repo.list(owner, "applications"),
    repo.list(owner, "events"),
    repo.list(owner, "queue"),
    careerConfigStatus(owner),
  ]);
  const profile = profiles[0] ?? null;
  const desc = (a: { created_at: string }, b: { created_at: string }) => b.created_at.localeCompare(a.created_at);
  // A versão do PDF não vai para o cliente inteira: páginas são pesadas e o
  // texto já está resumido nas análises. Mantém só o necessário.
  const lightResumes = resumes.sort(desc).map((r) => ({ ...r, pages: r.pages.map((p) => ({ page: p.page, text: p.text.slice(0, 1500) })) }));
  return {
    profile,
    preferences: prefs ?? defaultPreferences(owner, profile),
    resumes: lightResumes,
    analyses: analyses.sort(desc),
    linkChecks,
    jobs: jobs.sort((a, b) => (b.posted_at ?? b.collected_at).localeCompare(a.posted_at ?? a.collected_at)),
    matches,
    campaigns: campaigns.sort(desc),
    applications: applications.sort(desc),
    events: events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)),
    activeJobs: queue.filter((j) => j.status === "pendente" || j.status === "processando" || (j.status === "falhou" && Date.now() - Date.parse(j.updated_at) < 3_600_000)),
    config,
    defaultTemplates: defaultTemplates(null),
  };
}

export function applicationsCsv(applications: JobApplication[], jobs: JobPosting[]): string {
  const header = ["empresa", "vaga", "compatibilidade", "origem", "destino", "canal", "processamento", "email", "selecao", "enviado_em", "id_provedor", "versao_curriculo", "url"];
  const lines = applications.map((a) => {
    const job = jobs.find((j) => j.id === a.job_id);
    return [
      a.job_snapshot.company, a.job_snapshot.title, a.match_score, job?.source ?? "", a.recipient ?? a.manual_apply_url ?? "", a.channel,
      a.processing_status, a.email_status ?? "", a.selection_status, a.sent_at ?? "", a.provider_message_id ?? "", a.resume_version_id, a.job_snapshot.url,
    ].map(csvCell).join(";");
  });
  return [header.join(";"), ...lines].join("\n");
}

/* ------------------------------------------------------------------ */
/* Exclusão                                                            */
/* ------------------------------------------------------------------ */

/** Apaga tudo do titular: cancela jobs, remove arquivos e registros. */
export async function deleteCareerData(owner: Owner): Promise<void> {
  const repo = careerRepo();
  await cancelPendingJobs(owner, () => true);
  for (const c of await repo.list(owner, "campaigns")) {
    if (c.status === "ativa" || c.status === "pausada") await repo.update(owner, "campaigns", c.id, { status: "cancelada", updated_at: nowIso() });
  }
  for (const r of await repo.list(owner, "resumes")) await deleteFile(r.storage_key);
  const conns = await repo.list(owner, "connections");
  for (const c of conns) {
    const { revokeGmailTokens } = await import("@/providers/email/gmail");
    await revokeGmailTokens(c);
  }
  for (const col of ["events", "attempts", "applications", "campaigns", "matches", "jobs", "link_checks", "analyses", "resumes", "profiles", "connections", "queue"] as const) {
    await repo.remove(owner, col, {});
  }
  await repo.remove(owner, "preferences", { owner_id: owner.owner_id });
}
