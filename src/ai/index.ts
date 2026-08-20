import "server-only";
import { isLlmConfigured, llmComplete, llmModelName } from "@/ai/client";
import { analysisSchema, classificationSchema, type AnalysisOutput, type ClassificationOutput } from "@/ai/schemas";
import { buildAnalyzeLeadPrompt } from "@/ai/prompts/analyze-lead";
import { buildOutreachPrompt } from "@/ai/prompts/generate-outreach";
import { buildClassifyResponsePrompt } from "@/ai/prompts/classify-response";
import { buildObjectionPrompt } from "@/ai/prompts/handle-objection";
import { applyTone, engineAnalyze, engineClassify, engineObjection, engineOutreach } from "@/ai/engine";
import type { CompanyProfile, Lead, LeadAnalysis, MessageFormat, MessageTone } from "@/types";

/**
 * Fachada de IA: tenta o LLM configurado e valida o output com Zod;
 * qualquer falha (sem chave, erro de rede, JSON inválido) cai no
 * engine determinístico — o usuário nunca fica sem resposta.
 */

export { llmModelName, isLlmConfigured };

export async function aiAnalyzeLead(
  lead: Lead,
  profile: CompanyProfile
): Promise<{ output: AnalysisOutput; model: string }> {
  if (isLlmConfigured()) {
    const { system, user } = buildAnalyzeLeadPrompt(lead, profile);
    const raw = await llmComplete(system, user, { json: true, temperature: 0.4 });
    if (raw) {
      try {
        const parsed = analysisSchema.parse(JSON.parse(raw));
        return { output: parsed, model: llmModelName() };
      } catch (err) {
        console.error("[ai] análise do LLM inválida, usando engine:", err);
      }
    }
  }
  return { output: engineAnalyze(lead), model: "engine/deterministic-v1" };
}

export async function aiGenerateOutreach(
  lead: Lead,
  analysis: LeadAnalysis,
  profile: CompanyProfile,
  format: MessageFormat,
  tone: MessageTone,
  variant = 0,
  followUpContext?: string
): Promise<{ content: string; model: string }> {
  if (isLlmConfigured()) {
    const { system, user } = buildOutreachPrompt(lead, analysis, profile, format, tone, followUpContext);
    const raw = await llmComplete(system, user, { temperature: 0.8 });
    if (raw && raw.trim().length > 20) {
      return { content: raw.trim(), model: llmModelName() };
    }
  }
  const text = engineOutreach(lead, analysis, profile, format, tone, variant, followUpContext);
  return { content: applyTone(text, tone), model: "engine/deterministic-v1" };
}

export async function aiClassifyResponse(
  message: string
): Promise<{ output: ClassificationOutput; model: string }> {
  if (isLlmConfigured()) {
    const { system, user } = buildClassifyResponsePrompt(message);
    const raw = await llmComplete(system, user, { json: true, temperature: 0 });
    if (raw) {
      try {
        return { output: classificationSchema.parse(JSON.parse(raw)), model: llmModelName() };
      } catch {
        /* fallback abaixo */
      }
    }
  }
  return { output: engineClassify(message), model: "engine/deterministic-v1" };
}

export async function aiHandleObjection(
  objection: string,
  context: string,
  profile: CompanyProfile
): Promise<{ content: string; model: string }> {
  if (isLlmConfigured()) {
    const { system, user } = buildObjectionPrompt(objection, context, profile);
    const raw = await llmComplete(system, user, { temperature: 0.7 });
    if (raw && raw.trim().length > 20) return { content: raw.trim(), model: llmModelName() };
  }
  return { content: engineObjection(objection), model: "engine/deterministic-v1" };
}
