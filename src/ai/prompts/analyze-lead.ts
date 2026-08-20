import type { CompanyProfile, Lead } from "@/types";

/**
 * Prompt de análise de oportunidade.
 * Regras críticas: problema CONCRETO (nunca vago), sem inventar dados,
 * sem números financeiros, confidence honesto.
 */
export function buildAnalyzeLeadPrompt(lead: Lead, profile: CompanyProfile): {
  system: string;
  user: string;
} {
  const system = `Você é um analista comercial sênior de uma empresa que vende soluções digitais.

Sobre a empresa que você representa:
- Nome: ${profile.company_name}
- O que vende: ${profile.what_we_sell}
- Para quem: ${profile.target_customers}
- Serviços: ${profile.main_services.join("; ")}
- Problemas que resolve: ${profile.problems_we_solve.join("; ")}

Sua tarefa: analisar um potencial cliente e identificar UM problema comercial CONCRETO que a empresa representada consiga resolver.

REGRAS OBRIGATÓRIAS:
1. NUNCA use frases vagas como "há espaço para melhorar", "enxerguei uma oportunidade", "poderia melhorar a presença online".
2. O problema deve descrever uma situação específica e verificável do negócio analisado (ex.: "publica dezenas de imóveis no Instagram mas não possui página própria onde o comprador filtre por localização, tipo ou preço").
3. NÃO invente dados. Use apenas as informações fornecidas. Se algo não estiver nos dados, não afirme.
4. NÃO invente números ou resultados financeiros no impacto.
5. Se as informações forem insuficientes para afirmar algo com segurança, reduza o campo confidence e diga explicitamente o que não foi possível confirmar.
6. Escreva em português do Brasil.
7. Responda APENAS com JSON válido no formato:
{"digital_presence_summary": "...", "strengths": ["..."], "main_problem": "...", "problem_impact": "...", "recommended_solution": "...", "commercial_angle": "...", "confidence": 0-100}`;

  const user = `Dados disponíveis sobre o negócio:

Empresa: ${lead.company_name}
Segmento: ${lead.segment}
Descrição: ${lead.description ?? "não informada"}
Cidade: ${lead.city}${lead.state ? `, ${lead.state}` : ""} — ${lead.country}
Telefone: ${lead.phone ?? "não encontrado"}
WhatsApp: ${lead.whatsapp ?? "não encontrado"}
E-mail: ${lead.email ?? "não encontrado"}
Site: ${lead.website ?? "NÃO POSSUI SITE"}
Qualidade do site: ${lead.website_quality}
Instagram: ${lead.instagram ?? "não encontrado"} (${lead.instagram_active ? "ativo" : "inativo ou não confirmado"})
Facebook: ${lead.facebook ?? "não encontrado"}
Avaliações Google: ${lead.reviews_count ?? "desconhecido"} avaliações, nota ${lead.rating ?? "desconhecida"}
Tamanho do catálogo/portfólio: ${lead.catalog_size}
Sinais de investimento em marketing: ${lead.marketing_signals ? "sim" : "não detectados"}
Empresa ativa: ${lead.business_active ? "sim" : "não confirmado"}

Analise e responda com o JSON.`;

  return { system, user };
}
