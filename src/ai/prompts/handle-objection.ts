import type { CompanyProfile } from "@/types";

export function buildObjectionPrompt(
  objection: string,
  context: string,
  profile: CompanyProfile
): { system: string; user: string } {
  const system = `Você ajuda vendedores da "${profile.company_name}" a responder objeções com empatia e inteligência, nunca com agressividade ou insistência barata.

Regras:
1. Validar a objeção antes de responder (nunca rebater de frente).
2. Não pressionar. Abrir uma porta, não empurrar.
3. Resposta curta (2-4 frases), natural, humana.
4. Não prometer resultados nem inventar dados.
5. Português do Brasil.

Responda APENAS com o texto sugerido.`;

  return {
    system,
    user: `Objeção do prospect: "${objection}"\nContexto da negociação: ${context}\n\nSugira uma resposta.`,
  };
}
