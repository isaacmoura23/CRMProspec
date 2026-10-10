import type { Lead } from "@/types";
import type { ConversationState, DossierProfile, LeadDossier, Meeting } from "@/types/agents";

/**
 * A porta da construção de sites — regra pura, testada, e não texto de prompt.
 *
 * Construir um site gasta tempo e, mais importante, só faz sentido para quem
 * demonstrou interesse de verdade. Por isso a construção só começa quando
 * **todas** estas condições valem ao mesmo tempo:
 *
 *   1. o lead está em "interessado" (ou "reunião", etapa que ele ganha ao marcar);
 *   2. há **interesse explícito registrado**: uma mensagem do próprio lead que o comprova;
 *   3. existe uma **reunião agendada com data futura**;
 *   4. há tempo hábil: pronto até `reunião − margem`, senão o agente avisa em vez de entregar pela metade;
 *   5. o dossiê (Agente 3) existe, vale e comprova o mínimo para um site (nome e um contato).
 *
 * A função é chamada duas vezes: ao enfileirar e de novo quando a tarefa começa.
 */

export type SiteGateCode = "arquivado" | "status" | "sem_interesse" | "sem_reuniao" | "prazo" | "sem_dossie" | "dossie_insuficiente";

export type SiteGateResult = { ok: true; meeting: Pick<Meeting, "id" | "at">; deadline: Date } | { ok: false; code: SiteGateCode; reason: string };

export interface SiteGateInput {
  lead: Pick<Lead, "status" | "archived" | "source">;
  state: Pick<ConversationState, "interest_text" | "interest_at"> | null;
  meetings: Array<Pick<Meeting, "id" | "at" | "status">>;
  dossier: Pick<LeadDossier, "profile" | "valid_until" | "confidence"> | null;
  now: Date;
  /** Horas de folga antes da reunião. */
  marginHours: number;
}

/** Menor tempo em que uma prévia consegue ser construída e verificada. */
export const MIN_BUILD_MS = 10 * 60_000;
/** Confiança mínima do dossiê para construir. */
export const MIN_DOSSIER_CONFIDENCE = 40;

/** O perfil tem o mínimo para um site: nome e pelo menos um jeito de falar com a empresa. */
export function profileIsSufficient(profile: DossierProfile | null | undefined): boolean {
  return Boolean(profile && profile.name.trim() && (profile.whatsapp || profile.phone || profile.email));
}

export function siteBuildGate(i: SiteGateInput): SiteGateResult {
  if (i.lead.archived) return { ok: false, code: "arquivado", reason: "O lead está arquivado." };
  if (i.lead.status !== "interessado" && i.lead.status !== "reuniao") {
    return { ok: false, code: "status", reason: `O lead está em "${i.lead.status}": só quem demonstrou interesse recebe um site.` };
  }
  if (!i.state?.interest_text?.trim() || !i.state.interest_at) {
    return { ok: false, code: "sem_interesse", reason: "Não há interesse explícito registrado (uma mensagem do lead que o comprove)." };
  }
  const future = i.meetings
    .filter((m) => m.status === "agendada" && Date.parse(m.at) > i.now.getTime())
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  if (!future) return { ok: false, code: "sem_reuniao", reason: "Não há reunião agendada com data futura." };

  const deadline = new Date(Date.parse(future.at) - i.marginHours * 3_600_000);
  if (deadline.getTime() - i.now.getTime() < MIN_BUILD_MS) {
    return { ok: false, code: "prazo", reason: `Não há tempo hábil: a prévia precisa estar pronta ${i.marginHours} h antes da reunião e faltam menos de 10 minutos para esse prazo.` };
  }

  if (!i.dossier || i.dossier.valid_until <= i.now.toISOString()) return { ok: false, code: "sem_dossie", reason: "O lead não tem um dossiê válido (Agente 3)." };
  if (i.lead.source === "demo" || i.lead.source === "diretorio") return { ok: false, code: "dossie_insuficiente", reason: "Lead de demonstração: não há dados reais para um site." };
  if (!profileIsSufficient(i.dossier.profile)) return { ok: false, code: "dossie_insuficiente", reason: "O dossiê não comprova o mínimo para um site (nome e um contato). Refaça o dossiê." };
  if (i.dossier.confidence < MIN_DOSSIER_CONFIDENCE) return { ok: false, code: "dossie_insuficiente", reason: `A confiança do dossiê é baixa (${i.dossier.confidence}).` };

  return { ok: true, meeting: { id: future.id, at: future.at }, deadline };
}

export class SiteBuildGateError extends Error {
  constructor(
    public readonly code: SiteGateCode,
    message: string
  ) {
    super(message);
    this.name = "SiteBuildGateError";
  }
}
