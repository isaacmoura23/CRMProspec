import type { Lead } from "@/types";

/**
 * Quais leads as telas mostram por padrão.
 *
 * O seed existe para a primeira visita não ser uma tela vazia, mas os leads
 * fictícios têm score alto — 93, 93, 93, 88… — e as listas ordenam por
 * score. Resultado: depois de prospectar empresas de verdade, as sete
 * primeiras linhas continuavam sendo as mesmas sete fictícias, e a
 * impressão era de que "a busca traz sempre as mesmas empresas".
 *
 * Assim que existe lead real, os de demonstração saem da frente. Eles
 * continuam no banco e podem ser exibidos (`?demo=1`) ou removidos de vez
 * na própria tela de Leads.
 */
export function hideDemoLeads(leads: Lead[]): boolean {
  return leads.some((l) => l.source === "demo") && leads.some((l) => l.source !== "demo");
}

/** Lista que as telas devem usar. `incluirDemo` força a exibição completa. */
export function visibleLeads(leads: Lead[], incluirDemo = false): Lead[] {
  if (incluirDemo || !hideDemoLeads(leads)) return leads;
  return leads.filter((l) => l.source !== "demo");
}

export function countDemoLeads(leads: Lead[]): number {
  return leads.filter((l) => l.source === "demo").length;
}
