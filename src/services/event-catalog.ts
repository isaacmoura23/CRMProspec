/**
 * Catálogo de eventos de domínio.
 *
 * É a fonte única para os dois consumidores: os gatilhos de automação e as
 * assinaturas de webhook. Antes cada tela tinha sua própria lista de strings
 * soltas, sem nada do outro lado que as reconhecesse.
 *
 * Sem `server-only`: a UI importa os rótulos para montar os seletores.
 */

export const EVENT_TYPES = [
  "lead.created",
  "lead.scored",
  "lead.qualified",
  "lead.stage_changed",
  "lead.replied",
  "lead.stale",
  "task.created",
  "task.completed",
  "meeting.completed",
  "proposal.sent",
  "proposal.accepted",
  "deal.won",
  "deal.lost",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABEL: Record<EventType, string> = {
  "lead.created": "Lead criado",
  "lead.scored": "Lead recebe score",
  "lead.qualified": "Lead qualificado",
  "lead.stage_changed": "Lead muda de etapa",
  "lead.replied": "Lead respondeu",
  "lead.stale": "Lead sem contato há 5 dias",
  "task.created": "Tarefa criada",
  "task.completed": "Tarefa concluída",
  "meeting.completed": "Reunião concluída",
  "proposal.sent": "Proposta enviada",
  "proposal.accepted": "Proposta aceita",
  "deal.won": "Negócio ganho",
  "deal.lost": "Negócio perdido",
};

/** Gatilhos que fazem sentido para uma automação (todos, hoje). */
export const AUTOMATION_TRIGGERS: EventType[] = [...EVENT_TYPES];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Condições                                                           */
/* ------------------------------------------------------------------ */

export const CONDITIONS = [
  "always",
  "score_gte_80",
  "score_gte_60",
  "no_website",
  "priority_niche",
  "has_instagram",
] as const;

export type ConditionKey = (typeof CONDITIONS)[number];

export const CONDITION_LABEL: Record<ConditionKey, string> = {
  always: "Sempre",
  score_gte_80: "Score ≥ 80",
  score_gte_60: "Score ≥ 60",
  no_website: "Sem site",
  priority_niche: "Nicho prioritário",
  has_instagram: "Possui Instagram",
};

export function isConditionKey(value: string): value is ConditionKey {
  return (CONDITIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Ações                                                               */
/* ------------------------------------------------------------------ */

export const ACTIONS = [
  "stage.qualificado",
  "lead.mark_hot",
  "task.contact",
  "task.proposal",
  "followups.pause",
  "notify.owner",
] as const;

export type ActionKey = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<ActionKey, string> = {
  "stage.qualificado": "Mover para Qualificado",
  "lead.mark_hot": "Marcar como oportunidade quente",
  "task.contact": "Criar tarefa de contato",
  "task.proposal": 'Criar tarefa "Enviar proposta"',
  "followups.pause": "Pausar follow-ups automáticos",
  "notify.owner": "Notificar responsável",
};

export function isActionKey(value: string): value is ActionKey {
  return (ACTIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Compatibilidade com regras gravadas antes das chaves estáveis        */
/* ------------------------------------------------------------------ */

/**
 * As regras nasceram guardando o rótulo em português. Traduzimos na leitura
 * para que automações já criadas (inclusive as do seed) continuem valendo
 * sem exigir migração do banco.
 */
const LEGACY_TRIGGERS: Record<string, EventType> = {
  "Lead criado": "lead.created",
  "Lead recebe score": "lead.scored",
  "Lead respondeu": "lead.replied",
  "Reunião concluída": "meeting.completed",
  "Proposta enviada": "proposal.sent",
  "Proposta aceita": "proposal.accepted",
  "Lead sem contato há 5 dias": "lead.stale",
};

const LEGACY_CONDITIONS: Record<string, ConditionKey> = {
  Sempre: "always",
  "Score ≥ 80": "score_gte_80",
  "Score ≥ 60": "score_gte_60",
  "Sem site": "no_website",
  "Nicho prioritário": "priority_niche",
};

const LEGACY_ACTIONS: Record<string, ActionKey> = {
  "Mover para Qualificado": "stage.qualificado",
  "Criar tarefa de contato": "task.contact",
  "Adicionar à lista Alta prioridade": "lead.mark_hot",
  "Pausar follow-ups automáticos": "followups.pause",
  "Criar tarefa para o vendedor": "task.contact",
  "Criar tarefa para o responsável": "task.contact",
  'Criar tarefa "Enviar proposta"': "task.proposal",
  "Notificar responsável": "notify.owner",
};

export function normalizeTrigger(value: string): EventType | null {
  if (isEventType(value)) return value;
  return LEGACY_TRIGGERS[value] ?? null;
}

export function normalizeCondition(value: string): ConditionKey {
  if (isConditionKey(value)) return value;
  return LEGACY_CONDITIONS[value] ?? "always";
}

export function normalizeAction(value: string): ActionKey | null {
  if (isActionKey(value)) return value;
  return LEGACY_ACTIONS[value] ?? null;
}

/** Rótulo legível de um gatilho, aceitando também o formato antigo. */
export function triggerLabel(value: string): string {
  const key = normalizeTrigger(value);
  return key ? EVENT_LABEL[key] : value;
}

export function conditionLabel(value: string): string {
  return CONDITION_LABEL[normalizeCondition(value)];
}

export function actionLabel(value: string): string {
  const key = normalizeAction(value);
  return key ? ACTION_LABEL[key] : value;
}
