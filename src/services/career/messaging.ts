import { sanitizeHeader, textToHtml } from "@/lib/job-text";
import type { CareerProfile, JobMatch, JobPosting } from "@/types/career";

/**
 * Mensagem de candidatura determinística (sempre disponível).
 *
 * O modelo usa placeholders `{{...}}`; cada frase que depende de um dado
 * ausente é omitida inteira, e a saída é conferida: nenhum `{{` sobra.
 */

export const DEFAULT_SUBJECT = "Candidatura para {{cargo}} — {{nome}}";

export const DEFAULT_BODY = `Olá, equipe de recrutamento da {{empresa}}.

Gostaria de me candidatar à vaga de {{cargo}}, divulgada em {{fonte}}. Minha experiência com {{competencia_relevante}} está alinhada ao trabalho descrito em {{responsabilidade_da_vaga}}.

Em {{experiencia_ou_projeto_real}}, desenvolvi {{atividade_comprovada}}, com {{resultado_documentado}}. Também tenho experiência em {{segunda_competencia_confirmada}}, mencionada nos requisitos da oportunidade.

Encaminho meu currículo em anexo e fico à disposição para conversar sobre como posso contribuir com a equipe. Meu {{portfolio_ou_perfil}} está disponível em {{link_verificado}}.

Obrigado pela atenção,
{{nome}}
{{telefone_opcional}} · {{email}}`;

export const DEFAULT_BODY_EN = `Hello {{empresa}} hiring team,

I would like to apply for the {{cargo}} position posted on {{fonte}}. My experience with {{competencia_relevante}} aligns with the work described in {{responsabilidade_da_vaga}}.

At {{experiencia_ou_projeto_real}}, I worked on {{atividade_comprovada}}, with {{resultado_documentado}}. I also have experience with {{segunda_competencia_confirmada}}, which is listed in the role requirements.

My resume is attached and I would be glad to discuss how I can contribute to the team. My {{portfolio_ou_perfil}} is available at {{link_verificado}}.

Thank you for your time,
{{nome}}
{{telefone_opcional}} · {{email}}`;

export interface MessageData {
  [key: string]: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  remotive: "Remotive",
  adzuna: "Adzuna",
  url_import: "site da empresa",
  demo: "demonstração",
};

function firstMetric(text: string): string | null {
  const m = /[^.\n]*\b(\d+\s?%|R\$\s?[\d.,]+|US\$\s?[\d.,]+|\$[\d.,]+|\d{2,}\s?(clientes|usuários|usuarios|projetos|leads|vendas|users|customers|projects))\b[^.\n]*/i.exec(text);
  return m ? m[0].trim().replace(/^[-–•\s]+/, "") : null;
}

/** Monta os dados reais do modelo a partir do perfil e da vaga. Sem invenção: ausente = null. */
export function buildMessageData(profile: CareerProfile, job: JobPosting, match: JobMatch | null): MessageData {
  const metSkills = (match?.met ?? []).filter((m) => !m.startsWith("(desejável)") && !m.startsWith("Cargo") && !m.startsWith("Termos") && !/ano\(s\)/.test(m));
  const skillsInMatch = profile.skills.filter((s) => metSkills.some((m) => m.toLowerCase().includes(s.toLowerCase())));
  const primary = skillsInMatch[0] ?? profile.skills[0] ?? null;
  const secondary = skillsInMatch.find((s) => s !== primary) ?? profile.skills.find((s) => s !== primary) ?? null;
  const responsibility = metSkills[0] ?? job.requirements[0] ?? null;

  const exp = profile.experiences.find((e) => e.company || e.role) ?? null;
  const project = profile.projects[0] ?? null;
  const expLabel = exp ? (exp.company ? `${exp.company}${exp.role ? ` (${exp.role})` : ""}` : exp.role) : project?.name ?? null;
  const activity = exp?.description.split(/\n/).map((l) => l.replace(/^[-–•\s]+/, "").trim()).find((l) => l.length > 20) ?? project?.description ?? null;
  const metric = exp ? firstMetric(exp.description) : project ? firstMetric(project.description) : null;
  const link = profile.links.find((l) => /github|behance|dribbble|portfolio|\.dev|\.app/i.test(l)) ?? profile.links.find((l) => /linkedin/i.test(l)) ?? null;

  return {
    nome: profile.full_name || null,
    email: profile.email,
    telefone_opcional: profile.phone,
    empresa: job.company || null,
    cargo: job.title || null,
    fonte: SOURCE_LABEL[job.source] ?? job.source,
    competencia_relevante: primary,
    responsabilidade_da_vaga: responsibility ? responsibility.toLowerCase().replace(/[.;]+$/, "") : null,
    experiencia_ou_projeto_real: expLabel,
    atividade_comprovada: activity ? activity.replace(/[.;]+$/, "") : null,
    resultado_documentado: metric,
    segunda_competencia_confirmada: secondary,
    portfolio_ou_perfil: link ? (/linkedin/i.test(link) ? "perfil no LinkedIn" : "portfólio") : null,
    link_verificado: link,
  };
}

/**
 * Renderiza o modelo. Frases (separadas por ponto final) com placeholder
 * sem dado são removidas; linhas que ficarem vazias também. Garante que
 * não sobra `{{` no resultado.
 */
export function renderTemplate(template: string, data: MessageData): string {
  const paragraphs = template.split(/\n{2,}/);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split(/\n/).map((line) => {
      // Assinatura e linhas curtas: trata por segmento separado por " · "
      const segments = line.split(/\s·\s/).map((seg) => {
        const sentences = seg.split(/(?<=[.!?])\s+/);
        const kept = sentences.filter((s) => {
          const keys = [...s.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]!);
          return keys.every((k) => data[k]);
        });
        return kept.join(" ").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => data[k] ?? "");
      });
      return segments.filter((s) => s.trim()).join(" · ");
    });
    const text = lines.filter((l) => l.trim()).join("\n");
    if (text.trim()) out.push(text);
  }
  const result = out.join("\n\n").replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",");
  if (/\{\{|\}\}/.test(result)) throw new Error("Modelo com placeholder não resolvido");
  return result;
}

export interface RenderedMessage {
  subject: string;
  body_text: string;
  body_html: string;
}

export function renderApplicationMessage(
  templates: { subject: string; body: string },
  profile: CareerProfile,
  job: JobPosting,
  match: JobMatch | null
): RenderedMessage {
  const data = buildMessageData(profile, job, match);
  const subject = sanitizeHeader(renderTemplate(templates.subject, data).replace(/\n/g, " "), 150) || sanitizeHeader(`Candidatura — ${job.title}`);
  const body_text = renderTemplate(templates.body, data);
  return { subject, body_text, body_html: textToHtml(body_text) };
}

export function defaultTemplates(language: string | null): { subject: string; body: string } {
  if (language === "en") return { subject: "Application for {{cargo}} — {{nome}}", body: DEFAULT_BODY_EN };
  return { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY };
}
