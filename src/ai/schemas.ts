import { z } from "zod";

/** Output estruturado da análise de oportunidade */
export const analysisSchema = z.object({
  digital_presence_summary: z.string().min(20),
  strengths: z.array(z.string()).min(1).max(5),
  main_problem: z.string().min(40),
  problem_impact: z.string().min(20),
  recommended_solution: z.string().min(3),
  commercial_angle: z.string().min(10),
  confidence: z.number().min(0).max(100),
});

export type AnalysisOutput = z.infer<typeof analysisSchema>;

export const outreachSchema = z.object({
  message: z.string().min(30),
});

export const classificationSchema = z.object({
  classification: z.enum([
    "interessado",
    "quer_saber_mais",
    "preco",
    "sem_interesse",
    "sem_prioridade",
    "ja_possui_fornecedor",
    "quer_reuniao",
    "quer_proposta",
    "pediu_retorno_futuro",
    "informacao_insuficiente",
    "outra",
  ]),
  reasoning: z.string(),
});

export type ClassificationOutput = z.infer<typeof classificationSchema>;

export const CLASSIFICATION_LABEL: Record<ClassificationOutput["classification"], string> = {
  interessado: "Interessado",
  quer_saber_mais: "Quer saber mais",
  preco: "Perguntou preço",
  sem_interesse: "Sem interesse",
  sem_prioridade: "Sem prioridade",
  ja_possui_fornecedor: "Já possui fornecedor",
  quer_reuniao: "Quer reunião",
  quer_proposta: "Quer proposta",
  pediu_retorno_futuro: "Pediu retorno futuro",
  informacao_insuficiente: "Informação insuficiente",
  outra: "Outra",
};
