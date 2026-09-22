import { z } from "zod";

/** Saída do LLM ao extrair o perfil profissional do texto do currículo. */
export const profileExtractionSchema = z.object({
  full_name: z.string().max(120).nullable(),
  email: z.string().max(200).nullable(),
  phone: z.string().max(40).nullable(),
  location: z.string().max(120).nullable(),
  headline: z.string().max(120).nullable(),
  summary: z.string().max(1200).nullable(),
  experiences: z
    .array(
      z.object({
        company: z.string().max(120),
        role: z.string().max(120),
        start: z.string().max(10).nullable(),
        end: z.string().max(10).nullable(),
        description: z.string().max(2000),
        page: z.number().int().nullable(),
      })
    )
    .max(30),
  education: z
    .array(
      z.object({
        institution: z.string().max(160),
        degree: z.string().max(160),
        start: z.string().max(10).nullable(),
        end: z.string().max(10).nullable(),
        page: z.number().int().nullable(),
      })
    )
    .max(15),
  skills: z.array(z.string().max(60)).max(80),
  languages: z.array(z.string().max(60)).max(15),
  certifications: z.array(z.string().max(160)).max(30),
  projects: z
    .array(
      z.object({
        name: z.string().max(120),
        description: z.string().max(600),
        url: z.string().max(400).nullable(),
        page: z.number().int().nullable(),
      })
    )
    .max(20),
});

export type ProfileExtraction = z.infer<typeof profileExtractionSchema>;

/** Sugestões de revisão. Cada `original` precisa existir no texto — validado depois. */
export const resumeReviewSchema = z.object({
  spelling_and_grammar: z
    .array(
      z.object({
        original: z.string().max(400),
        suggested: z.string().max(400),
        problem: z.string().max(200),
      })
    )
    .max(25),
  rewrites: z
    .array(
      z.object({
        original: z.string().max(600),
        suggested: z.string().max(800),
        problem: z.string().max(240),
        rationale: z.string().max(400),
        priority: z.enum(["alta", "media", "baixa"]),
        needs_user_input: z.boolean(),
      })
    )
    .max(15),
  observations: z.array(z.string().max(300)).max(8),
});

export type ResumeReview = z.infer<typeof resumeReviewSchema>;

export const applicationMessageSchema = z.object({
  subject: z.string().min(8).max(150),
  body: z.string().min(80).max(2500),
  /** Competências do perfil citadas na mensagem — conferidas contra o perfil. */
  skills_used: z.array(z.string().max(60)).max(6),
});

export type ApplicationMessage = z.infer<typeof applicationMessageSchema>;
