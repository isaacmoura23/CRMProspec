import type { Role } from "@/types";

/**
 * Matriz de permissões — pura, para ser testada sem servidor.
 *
 * Três níveis, alinhados aos papéis descritos na tela de Equipe:
 *
 *   - **leitura**: todo mundo com sessão, inclusive `viewer`.
 *   - **escrita** (operação do dia a dia: leads, tarefas, notas, propostas,
 *     campanhas, prospecção, mensagens): todos menos `viewer`, que é
 *     "somente leitura".
 *   - **administração** (configuração da organização: equipe, webhooks,
 *     etapas do pipeline, automações, preferências, perfil da empresa):
 *     `owner` e `admin` — SDR e vendedor têm "acesso quase total" apenas na
 *     descrição do admin, não na deles.
 *
 * Esconder um botão é conveniência; quem recusa é a server action. Toda
 * verificação aqui roda no servidor, antes da escrita.
 */

export const WRITE_ROLES: readonly Role[] = ["owner", "admin", "sdr", "vendedor"];
export const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];

export function canWrite(role: Role): boolean {
  return WRITE_ROLES.includes(role);
}

export function canAdminister(role: Role): boolean {
  return ADMIN_ROLES.includes(role);
}

/** Mensagem única, para a interface não inventar variações. */
export const WRITE_DENIED = "Seu perfil é somente leitura. Peça a um administrador para alterar seu papel.";
export const ADMIN_DENIED = "Apenas owner ou admin podem fazer esta alteração.";
