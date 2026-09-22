"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { isValidEmail } from "@/lib/job-text";
import { revokeGmailTokens } from "@/providers/email/gmail";
import { careerRepo } from "@/services/career/repository";
import { kickWorker } from "@/services/career/queue";
import {
  applicationsCsv,
  createCampaign,
  deleteCareerData,
  deleteResumeVersion,
  finalizeResumeUpload,
  generateRevisedResume,
  getCareerSnapshot,
  importJob,
  markManualApplicationDone,
  ownerOf,
  prepareResumeUpload,
  previewCampaign,
  requestAnalysis,
  requestJobSearch,
  resumeDownloadUrl,
  retryApplication,
  savePreferences,
  setCampaignStatus,
  setSuggestionStatus,
  updateProfile,
  updateSelectionStatus,
  type CampaignInput,
  type CampaignPreview,
  type CareerSnapshot,
} from "@/services/career/service";
import type { ApplicationCampaign, CareerJob, CareerPreferences, CareerProfile } from "@/types/career";

/**
 * Server Actions do módulo Carreira. Todas exigem sessão e derivam o
 * titular dela; nenhum owner_id vem do cliente.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Falha inesperada." };
}

async function owner() {
  return ownerOf(await getCurrentUser());
}

export async function getCareer(): Promise<CareerSnapshot> {
  return getCareerSnapshot(await owner());
}

/** Polling leve para a interface acompanhar progresso. */
export async function getCareerJobs(): Promise<CareerJob[]> {
  const o = await owner();
  const jobs = await careerRepo().list(o, "queue");
  // Se há job vencido e nenhum worker rodando, a navegação acorda o worker.
  const due = jobs.some((j) => (j.status === "pendente" || j.status === "processando") && j.next_run_at <= new Date().toISOString() && (!j.locked_until || j.locked_until < new Date().toISOString()));
  if (due) kickWorker();
  return jobs.filter((j) => j.status !== "concluido" || Date.now() - Date.parse(j.updated_at) < 60_000);
}

/* ---------------- Currículo ---------------- */

const prepareSchema = z.object({ fileName: z.string().min(1).max(200), sizeBytes: z.number().int().min(1) });

export async function prepareUpload(input: z.infer<typeof prepareSchema>): Promise<Result<{ versionId: string; target: Awaited<ReturnType<typeof prepareResumeUpload>>["target"] }>> {
  const parsed = prepareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Arquivo inválido." };
  try {
    const res = await prepareResumeUpload(await owner(), parsed.data.fileName, parsed.data.sizeBytes);
    return { ok: true, ...res };
  } catch (err) {
    return fail(err);
  }
}

export async function finalizeUpload(versionId: string): Promise<Result<{ versionId: string; duplicateOf: string | null; textStatus: string; textNote: string | null }>> {
  if (typeof versionId !== "string") return { ok: false, error: "Versão inválida." };
  try {
    const { version, duplicateOf } = await finalizeResumeUpload(await owner(), versionId);
    revalidatePath("/carreira");
    return { ok: true, versionId: version.id, duplicateOf, textStatus: version.text_status, textNote: version.text_note };
  } catch (err) {
    return fail(err);
  }
}

export async function removeResume(versionId: string): Promise<Result> {
  try {
    await deleteResumeVersion(await owner(), versionId);
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function getResumeUrl(versionId: string): Promise<Result<{ url: string }>> {
  const url = await resumeDownloadUrl(await owner(), versionId);
  return url ? { ok: true, url } : { ok: false, error: "Versão não encontrada." };
}

export async function reanalyze(versionId: string): Promise<Result> {
  try {
    await requestAnalysis(await owner(), versionId);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- Perfil e preferências ---------------- */

const experienceSchema = z.object({ company: z.string().max(120), role: z.string().max(120), start: z.string().max(10).nullable(), end: z.string().max(10).nullable(), description: z.string().max(3000), page: z.number().int().nullable() });
const educationSchema = z.object({ institution: z.string().max(160), degree: z.string().max(160), start: z.string().max(10).nullable(), end: z.string().max(10).nullable(), page: z.number().int().nullable() });
const projectSchema = z.object({ name: z.string().max(120), description: z.string().max(800), url: z.string().max(400).nullable(), page: z.number().int().nullable() });

const profileSchema = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().max(200).nullable(),
  phone: z.string().max(40).nullable(),
  location: z.string().max(120).nullable(),
  headline: z.string().max(120).nullable(),
  summary: z.string().max(1500).nullable(),
  experiences: z.array(experienceSchema).max(30),
  education: z.array(educationSchema).max(15),
  skills: z.array(z.string().max(60)).max(80),
  languages: z.array(z.string().max(60)).max(15),
  certifications: z.array(z.string().max(160)).max(30),
  projects: z.array(projectSchema).max(20),
  links: z.array(z.string().max(400)).max(30),
  confirmed: z.boolean(),
});

export async function saveProfile(input: z.infer<typeof profileSchema>): Promise<Result<{ profile: CareerProfile }>> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Dados do perfil inválidos. Confira os campos." };
  if (parsed.data.email && !isValidEmail(parsed.data.email)) return { ok: false, error: "E-mail inválido." };
  try {
    const profile = await updateProfile(await owner(), parsed.data);
    if (!profile) return { ok: false, error: "Envie um currículo antes de editar o perfil." };
    revalidatePath("/carreira");
    return { ok: true, profile };
  } catch (err) {
    return fail(err);
  }
}

const prefsSchema = z.object({
  desired_roles: z.array(z.string().max(80)).max(10),
  locations: z.array(z.string().max(80)).max(10),
  work_modes: z.array(z.enum(["remoto", "hibrido", "presencial"])).max(3),
  languages: z.array(z.string().max(40)).max(10),
  contract_types: z.array(z.string().max(40)).max(6),
  min_salary: z.number().min(0).nullable(),
  currency: z.string().min(3).max(3),
  excluded_companies: z.array(z.string().max(80)).max(50),
  min_match_score: z.number().int().min(0).max(100),
  candidate_email: z.string().max(200).nullable(),
});

export async function savePrefs(input: z.infer<typeof prefsSchema>): Promise<Result<{ preferences: CareerPreferences }>> {
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Preferências inválidas." };
  if (parsed.data.candidate_email && !isValidEmail(parsed.data.candidate_email)) return { ok: false, error: "E-mail de contato inválido." };
  try {
    const preferences = await savePreferences(await owner(), parsed.data);
    revalidatePath("/carreira");
    return { ok: true, preferences };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- Sugestões ---------------- */

const suggestionSchema = z.object({
  analysisId: z.string(),
  suggestionId: z.string(),
  status: z.enum(["pendente", "aceita", "rejeitada"]),
  edited: z.string().max(2000).nullable(),
});

export async function decideSuggestion(input: z.infer<typeof suggestionSchema>): Promise<Result> {
  const parsed = suggestionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };
  try {
    await setSuggestionStatus(await owner(), parsed.data.analysisId, parsed.data.suggestionId, parsed.data.status, parsed.data.edited);
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function buildRevisedResume(analysisId: string): Promise<Result<{ versionId: string }>> {
  try {
    const version = await generateRevisedResume(await owner(), analysisId);
    revalidatePath("/carreira");
    return { ok: true, versionId: version.id };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- Vagas ---------------- */

export async function searchJobs(): Promise<Result> {
  try {
    const res = await requestJobSearch(await owner());
    if (res.error) return { ok: false, error: res.error };
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function importJobUrl(url: string): Promise<Result<{ jobId: string }>> {
  if (typeof url !== "string" || url.length > 2000) return { ok: false, error: "URL inválida." };
  try {
    const res = await importJob(await owner(), url);
    if ("error" in res) return { ok: false, error: res.error };
    revalidatePath("/carreira");
    return { ok: true, jobId: res.job.id };
  } catch (err) {
    return fail(err);
  }
}

export async function flagMatch(matchId: string, patch: { saved?: boolean; dismissed?: boolean }): Promise<Result> {
  try {
    const o = await owner();
    const updated = await careerRepo().update(o, "matches", matchId, { ...(patch.saved !== undefined ? { saved: patch.saved } : {}), ...(patch.dismissed !== undefined ? { dismissed: patch.dismissed } : {}) });
    if (!updated) return { ok: false, error: "Vaga não encontrada." };
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- Campanhas ---------------- */

const campaignSchema = z.object({
  name: z.string().max(80),
  job_ids: z.array(z.string()).max(200),
  recurring: z.boolean(),
  roles: z.array(z.string().max(80)).max(10),
  min_score: z.number().int().min(0).max(100),
  resume_version_id: z.string(),
  channel: z.enum(["resend", "gmail", "manual"]),
  daily_limit: z.number().int().min(1).max(200),
  ends_at: z.string().nullable(),
  template_subject: z.string().min(4).max(200),
  template_body: z.string().min(40).max(5000),
});

export async function previewCampaignAction(input: CampaignInput): Promise<Result<{ previews: CampaignPreview[]; warnings: string[] }>> {
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Parâmetros da campanha inválidos." };
  try {
    const res = await previewCampaign(await owner(), parsed.data);
    return { ok: true, ...res };
  } catch (err) {
    return fail(err);
  }
}

export async function startCampaign(input: CampaignInput): Promise<Result<{ campaign: ApplicationCampaign }>> {
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Parâmetros da campanha inválidos." };
  try {
    const campaign = await createCampaign(await owner(), parsed.data);
    revalidatePath("/carreira");
    return { ok: true, campaign };
  } catch (err) {
    return fail(err);
  }
}

export async function changeCampaignStatus(campaignId: string, status: "ativa" | "pausada" | "cancelada"): Promise<Result> {
  if (!["ativa", "pausada", "cancelada"].includes(status)) return { ok: false, error: "Status inválido." };
  try {
    const c = await setCampaignStatus(await owner(), campaignId, status);
    if (!c) return { ok: false, error: "Campanha não encontrada." };
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/* ---------------- Candidaturas ---------------- */

const selectionSchema = z.object({
  applicationId: z.string(),
  status: z.enum(["registrada", "resposta_recebida", "entrevista", "proposta", "contratado", "rejeitado", "retirada"]),
  note: z.string().max(500).nullable(),
});

export async function setSelection(input: z.infer<typeof selectionSchema>): Promise<Result> {
  const parsed = selectionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Entrada inválida." };
  try {
    await updateSelectionStatus(await owner(), parsed.data.applicationId, parsed.data.status, parsed.data.note);
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function completeManual(applicationId: string, note: string | null): Promise<Result> {
  try {
    await markManualApplicationDone(await owner(), applicationId, note);
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function retrySend(applicationId: string): Promise<Result> {
  try {
    await retryApplication(await owner(), applicationId);
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function exportApplicationsCsv(): Promise<string> {
  const o = await owner();
  const repo = careerRepo();
  const [apps, jobs] = await Promise.all([repo.list(o, "applications"), repo.list(o, "jobs")]);
  return applicationsCsv(apps, jobs);
}

/* ---------------- Conexões e exclusão ---------------- */

export async function disconnectGmail(): Promise<Result> {
  try {
    const o = await owner();
    const repo = careerRepo();
    const conns = await repo.list(o, "connections", { provider: "gmail" });
    for (const c of conns) {
      await revokeGmailTokens(c);
      await repo.remove(o, "connections", { id: c.id });
    }
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function eraseCareerData(confirmation: string): Promise<Result> {
  if (confirmation !== "EXCLUIR") return { ok: false, error: "Digite EXCLUIR para confirmar." };
  try {
    await deleteCareerData(await owner());
    revalidatePath("/carreira");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
