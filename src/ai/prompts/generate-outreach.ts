import type { CompanyProfile, Lead, LeadAnalysis, MessageFormat, MessageTone } from "@/types";
import { list } from "@/ai/prompts/format";

export const FORMAT_LABEL: Record<MessageFormat, string> = {
  curta: "Mensagem curta",
  consultiva: "Mensagem consultiva",
  whatsapp: "WhatsApp",
  instagram_dm: "Instagram DM",
  email: "E-mail",
  audio: "Roteiro de áudio",
  follow_up: "Follow-up",
};

const FORMAT_INSTRUCTIONS: Record<MessageFormat, string> = {
  curta: "Mensagem de no máximo 3 frases, direta mas humana.",
  consultiva: "Mensagem consultiva de 4-6 frases, tom de especialista que percebeu algo específico.",
  whatsapp: "Mensagem de WhatsApp: informal-profissional, 3-5 frases, sem assunto, sem assinatura formal.",
  instagram_dm: "Direct do Instagram: curto, casual, natural, máximo 4 frases. Mencionar que viu o perfil.",
  email: "E-mail frio: linha de assunto curta e curiosa (prefixe com 'Assunto: '), corpo de 4-6 frases, assinatura simples com o primeiro nome.",
  audio: "Roteiro de áudio de WhatsApp: linguagem 100% falada, com pausas naturais, contrações ('tava', 'pra'), como uma pessoa real gravando um áudio de 30-40 segundos. NÃO pode soar como texto lido.",
  follow_up: "Follow-up educado que retoma a conversa sem pressão, referenciando o contexto anterior.",
};

const TONE_INSTRUCTIONS: Record<MessageTone, string> = {
  padrao: "",
  mais_curto: "Reduza o texto ao essencial, mantendo a personalização.",
  mais_direto: "Vá mais direto ao ponto, menos rodeios.",
  mais_informal: "Deixe mais informal e leve, como uma conversa entre conhecidos.",
  mais_profissional: "Deixe mais profissional e polido, sem perder naturalidade.",
};

export function buildOutreachPrompt(
  lead: Lead,
  analysis: LeadAnalysis,
  profile: CompanyProfile,
  format: MessageFormat,
  tone: MessageTone,
  followUpContext?: string
): { system: string; user: string } {
  const system = `Você escreve abordagens comerciais de prospecção para a empresa "${profile.company_name}".

Contexto da empresa:
- O que vende: ${profile.what_we_sell}
- Estilo de comunicação: ${profile.communication_style}
- NUNCA dizer/fazer: ${list(profile.never_say)}

REGRAS DA PRIMEIRA ABORDAGEM:
1. Estrutura: cumprimento → contextualização natural (ex.: "dei uma olhada no perfil de vocês") → problema específico percebido → impacto resumido → curiosidade → pergunta de abertura ("Posso te mostrar?", "Quer que eu te explique rapidinho?").
2. NÃO revelar a solução completa. A curiosidade vem da solução ainda não revelada.
3. NUNCA usar frases vagas ("vi uma oportunidade", "percebi um ponto de melhoria").
4. Mencionar o problema ESPECÍFICO detectado na análise, com naturalidade.
5. Não prometer resultados. Não inventar dados.
6. Texto curto — ninguém lê parágrafos longos de desconhecidos.
7. Linguagem humana, natural, sem cara de mensagem de IA ou template. Sem emojis em excesso (no máximo 1, e só se combinar com o canal).
8. Português do Brasil${lead.country === "Portugal" ? " (o prospect é de Portugal, então evite gírias muito brasileiras)" : ""}.

Formato solicitado: ${FORMAT_INSTRUCTIONS[format]}
${tone !== "padrao" ? `Ajuste de tom: ${TONE_INSTRUCTIONS[tone]}` : ""}

Responda APENAS com o texto da mensagem, sem comentários.`;

  const user = `Prospect: ${lead.company_name} (${lead.segment}, ${lead.city})
Nome do contato: ${lead.contact_name ?? "desconhecido — não use nome próprio"}

Análise do negócio:
- Presença digital: ${analysis.digital_presence_summary}
- Problema identificado: ${analysis.main_problem}
- Impacto: ${analysis.problem_impact}
- Ângulo comercial: ${analysis.commercial_angle}
${followUpContext ? `\nContexto do follow-up (última interação): ${followUpContext}` : ""}

Escreva a mensagem.`;

  return { system, user };
}
