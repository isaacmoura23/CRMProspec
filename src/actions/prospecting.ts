"use server";

import { z } from "zod";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { createProspectingJob } from "@/jobs/prospecting";
import type { ProspectingJob } from "@/types";

const searchSchema = z.object({
  niche: z.string().min(2).max(60),
  country: z.string().min(2).max(60),
  state: z.string().max(60).optional(),
  city: z.string().min(2).max(80),
  region: z.string().max(80).optional(),
  quantity: z.number().int().min(1).max(100),
  campaignName: z.string().max(80).optional(),
  filters: z.object({
    hasPhone: z.boolean().optional(),
    hasWhatsapp: z.boolean().optional(),
    hasInstagram: z.boolean().optional(),
    hasEmail: z.boolean().optional(),
    noWebsite: z.boolean().optional(),
    hasWebsite: z.boolean().optional(),
    badWebsite: z.boolean().optional(),
    activeBusiness: z.boolean().optional(),
    hasReviews: z.boolean().optional(),
    strongSocial: z.boolean().optional(),
  }),
});

export async function startProspecting(
  input: z.infer<typeof searchSchema>
): Promise<{ jobId: string } | { error: string }> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Parâmetros de busca inválidos. Revise os campos e tente novamente." };
  }
  if (parsed.data.filters.noWebsite && parsed.data.filters.hasWebsite) {
    return { error: "Os filtros “sem site” e “possui site” não podem ser combinados." };
  }
  const user = await getCurrentUser();
  const job = createProspectingJob(parsed.data, user.id);
  return { jobId: job.id };
}

/**
 * Um job só existe na memória do processo que o iniciou. Se essa execução
 * for interrompida (limite de duração da função, cold start, deploy), nada
 * marca o job como encerrado e a tela ficaria girando para sempre.
 */
const JOB_STALE_MS = 6 * 60 * 1000;

function expireIfStale(job: ProspectingJob): ProspectingJob {
  if (job.status !== "processing" && job.status !== "queued") return job;
  const startedAt = Date.parse(job.created_at);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < JOB_STALE_MS) return job;

  job.status = "failed";
  job.finished_at = nowIso();
  job.errors.push(
    "A busca foi interrompida antes de terminar. Os leads já encontrados foram salvos — tente novamente para completar."
  );
  for (const s of job.steps) if (s.status === "processing") s.status = "failed";
  saveDb();
  return job;
}

export async function getProspectingJob(jobId: string): Promise<ProspectingJob | null> {
  await getCurrentUser();
  const db = getDb();
  const job = db.prospecting_jobs.find((j) => j.id === jobId);
  return job ? expireIfStale(job) : null;
}

export async function getRecentJobs(): Promise<ProspectingJob[]> {
  await getCurrentUser();
  const db = getDb();
  return [...db.prospecting_jobs]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5)
    .map(expireIfStale);
}
