import "server-only";
import { isLlmConfigured, llmComplete, llmModelName } from "@/ai/client";
import {
  applicationMessageSchema,
  profileExtractionSchema,
  resumeReviewSchema,
  type ApplicationMessage,
  type ProfileExtraction,
  type ResumeReview,
} from "@/ai/career-schemas";
import { buildExtractProfilePrompt, buildReviewResumePrompt } from "@/ai/prompts/analyze-resume";
import { buildApplicationMessagePrompt } from "@/ai/prompts/generate-application";
import type { CareerProfile, JobMatch, JobPosting, ResumePage } from "@/types/career";

/**
 * Fachada de IA do módulo Carreira. Mesma filosofia da fachada comercial:
 * tenta o LLM, valida com Zod, e devolve `null` para o chamador usar o motor
 * determinístico. Nenhum destes métodos executa ação externa — só produz
 * texto estruturado que o backend ainda confere.
 */

export async function aiExtractProfile(pages: ResumePage[]): Promise<{ output: ProfileExtraction; model: string } | null> {
  if (!isLlmConfigured()) return null;
  const { system, user } = buildExtractProfilePrompt(pages);
  const raw = await llmComplete(system, user, { json: true, temperature: 0 });
  if (!raw) return null;
  try {
    return { output: profileExtractionSchema.parse(JSON.parse(raw)), model: llmModelName() };
  } catch (err) {
    console.error("[ai/career] extração de perfil inválida:", err);
    return null;
  }
}

export async function aiReviewResume(
  pages: ResumePage[],
  context: { profession: string | null; seniority: string | null; country: string | null }
): Promise<{ output: ResumeReview; model: string } | null> {
  if (!isLlmConfigured()) return null;
  const { system, user } = buildReviewResumePrompt(pages, context);
  const raw = await llmComplete(system, user, { json: true, temperature: 0.2 });
  if (!raw) return null;
  try {
    return { output: resumeReviewSchema.parse(JSON.parse(raw)), model: llmModelName() };
  } catch (err) {
    console.error("[ai/career] revisão inválida:", err);
    return null;
  }
}

export async function aiWriteApplication(
  profile: CareerProfile,
  job: JobPosting,
  match: JobMatch | null,
  template: { subject: string; body: string },
  language: string
): Promise<{ output: ApplicationMessage; model: string } | null> {
  if (!isLlmConfigured()) return null;
  const { system, user } = buildApplicationMessagePrompt(profile, job, match, template, language);
  const raw = await llmComplete(system, user, { json: true, temperature: 0.5 });
  if (!raw) return null;
  try {
    const output = applicationMessageSchema.parse(JSON.parse(raw));
    // Cada competência citada precisa constar do perfil confirmado.
    const known = new Set(profile.skills.map((s) => s.toLowerCase()));
    const unknown = output.skills_used.filter((s) => !known.has(s.toLowerCase()));
    if (unknown.length > 0) {
      console.warn("[ai/career] mensagem citou competências fora do perfil, descartada:", unknown);
      return null;
    }
    if (/\{\{|\}\}|\[[^\]]*\]/.test(output.body) || /\{\{|\}\}/.test(output.subject)) return null;
    return { output, model: llmModelName() };
  } catch (err) {
    console.error("[ai/career] mensagem inválida:", err);
    return null;
  }
}
