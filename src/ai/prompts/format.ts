/**
 * Helpers de formatação usados na montagem dos prompts.
 *
 * O perfil da empresa vive no banco desde antes da validação com Zod, então
 * snapshots antigos ainda podem ter listas ausentes. `join` direto nesses
 * campos derrubava toda a geração com LLM ativo.
 */
export function list(values: string[] | undefined | null): string {
  const items = (values ?? []).map((v) => v?.trim()).filter(Boolean);
  return items.length ? items.join("; ") : "não informado";
}
