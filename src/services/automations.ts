import "server-only";
import { getDb, nowIso } from "@/lib/store";
import { uid } from "@/lib/utils";
import { logActivity } from "@/services/activity";
import {
  normalizeAction,
  normalizeCondition,
  normalizeTrigger,
  type ActionKey,
  type ConditionKey,
  type EventType,
} from "@/services/event-catalog";
import type { AutomationRule, Lead } from "@/types";

/**
 * Motor de automações: gatilho → condição → ação.
 *
 * As ações mutam o banco diretamente em vez de chamar lead-service. Isso é
 * deliberado: passar por setLeadStatus emitiria um novo evento e uma regra
 * poderia reagir à própria consequência, em laço. Em vez disso cada ação
 * devolve os eventos que causou, e services/events os entrega aos webhooks
 * marcados como `fromAutomation` — chegam a quem escuta de fora sem
 * reentrar no motor.
 */

export interface DerivedEvent {
  type: EventType;
  payload?: Record<string, unknown>;
}

export interface AutomationOutcome {
  rule: string;
  actions: ActionKey[];
  /** Eventos causados pelas ações — notificam webhooks, mas não o motor. */
  events: DerivedEvent[];
}

function matchesCondition(condition: ConditionKey, lead: Lead | null): boolean {
  if (condition === "always") return true;
  if (!lead) return false;
  switch (condition) {
    case "score_gte_80":
      return (lead.lead_score ?? 0) >= 80;
    case "score_gte_60":
      return (lead.lead_score ?? 0) >= 60;
    case "no_website":
      return !lead.has_website;
    case "has_instagram":
      return Boolean(lead.instagram);
    case "priority_niche": {
      const niches = getDb().company_profile.priority_niches ?? [];
      const segment = lead.segment.toLowerCase();
      return niches.some((n) => {
        const niche = n.toLowerCase();
        return segment.includes(niche) || niche.includes(segment);
      });
    }
  }
}

/** Tarefa com vencimento em `hours` horas a partir de agora. */
function scheduleTask(
  lead: Lead,
  type: "ligar" | "proposta",
  title: string,
  hours: number,
  priority: "alta" | "media"
): DerivedEvent {
  const db = getDb();
  const due = new Date(Date.now() + hours * 3_600_000);
  const task = {
    id: uid("task"),
    organization_id: db.organization.id,
    lead_id: lead.id,
    assigned_to: lead.assigned_to ?? db.users.find((u) => u.role === "owner")?.id ?? db.users[0]!.id,
    type,
    title,
    description: "Criada automaticamente por uma automação.",
    due_date: due.toISOString(),
    priority,
    completed: false,
    completed_at: null,
    created_at: nowIso(),
  } as const;
  db.tasks.push(task);
  return {
    type: "task.created",
    payload: {
      task: {
        id: task.id,
        lead_id: task.lead_id,
        type: task.type,
        title: task.title,
        due_date: task.due_date,
        priority: task.priority,
        assigned_to: task.assigned_to,
        completed: false,
      },
      source: "automation",
    },
  };
}

/**
 * Executa uma ação. Devolve `null` quando nada mudou, ou a lista de eventos
 * que a mudança provoca — eles chegam aos webhooks sem reentrar no motor.
 */
function runAction(action: ActionKey, lead: Lead | null, ruleName: string): DerivedEvent[] | null {
  const db = getDb();
  if (!lead) return null;

  switch (action) {
    case "stage.qualificado": {
      if (lead.status === "qualificado") return null;
      // Etapas terminais não voltam atrás por automação.
      const currentStage = db.pipeline_stages.find((s) => s.id === lead.pipeline_stage_id);
      if (currentStage?.is_won || currentStage?.is_lost) return null;
      lead.status = "qualificado";
      const stage = db.pipeline_stages.find((s) => s.name === "Qualificado");
      if (stage) {
        lead.pipeline_stage_id = stage.id;
        lead.stage_entered_at = nowIso();
      }
      lead.updated_at = nowIso();
      logActivity(lead.id, "status_alterado", `Automação "${ruleName}": movido para Qualificado`, null);
      return [{ type: "lead.stage_changed" }, { type: "lead.qualified" }];
    }

    case "lead.mark_hot": {
      if (lead.temperature === "quente") return null;
      lead.temperature = "quente";
      lead.updated_at = nowIso();
      logActivity(lead.id, "status_alterado", `Automação "${ruleName}": marcado como oportunidade quente`, null);
      return [];
    }

    case "task.contact": {
      // Não empilha uma segunda tarefa de contato ainda aberta.
      const open = db.tasks.some(
        (t) => t.lead_id === lead.id && t.type === "ligar" && !t.completed
      );
      if (open) return null;
      const created = scheduleTask(lead, "ligar", `Entrar em contato com ${lead.company_name}`, 24, "alta");
      logActivity(lead.id, "tarefa_criada", `Automação "${ruleName}": tarefa de contato criada`, null);
      return [created];
    }

    case "task.proposal": {
      const open = db.tasks.some(
        (t) => t.lead_id === lead.id && t.type === "proposta" && !t.completed
      );
      if (open) return null;
      const created = scheduleTask(lead, "proposta", `Enviar proposta para ${lead.company_name}`, 48, "alta");
      logActivity(lead.id, "tarefa_criada", `Automação "${ruleName}": tarefa de proposta criada`, null);
      return [created];
    }

    case "followups.pause": {
      const pending = db.tasks.filter(
        (t) => t.lead_id === lead.id && t.type === "follow_up" && !t.completed
      );
      if (!lead.next_follow_up_at && pending.length === 0) return null;
      lead.next_follow_up_at = null;
      for (const t of pending) {
        t.completed = true;
        t.completed_at = nowIso();
      }
      lead.updated_at = nowIso();
      logActivity(lead.id, "follow_up", `Automação "${ruleName}": cadência pausada`, null);
      return [];
    }

    case "notify.owner": {
      const userId =
        lead.assigned_to ?? db.users.find((u) => u.role === "owner")?.id ?? db.users[0]!.id;
      db.notifications.unshift({
        id: uid("ntf"),
        organization_id: db.organization.id,
        user_id: userId,
        title: `${lead.company_name} precisa da sua atenção`,
        body: `Disparado pela automação "${ruleName}".`,
        link: `/leads/${lead.id}`,
        read: false,
        created_at: nowIso(),
      });
      return [];
    }
  }
}

/**
 * Roda as automações ativas para um evento. Retorna o que foi executado —
 * o chamador decide o que persistir e revalidar.
 */
export function runAutomations(event: EventType, lead: Lead | null): AutomationOutcome[] {
  const db = getDb();
  const outcomes: AutomationOutcome[] = [];

  for (const rule of db.automation_rules as AutomationRule[]) {
    if (!rule.active) continue;
    if (normalizeTrigger(rule.trigger) !== event) continue;
    if (!matchesCondition(normalizeCondition(rule.condition), lead)) continue;

    const applied: ActionKey[] = [];
    const events: DerivedEvent[] = [];
    for (const raw of rule.actions) {
      const action = normalizeAction(raw);
      if (!action) continue;
      try {
        const derived = runAction(action, lead, rule.name);
        if (derived) {
          applied.push(action);
          events.push(...derived);
        }
      } catch (err) {
        console.error(`[automations] ação "${action}" da regra "${rule.name}" falhou:`, err);
      }
    }

    // `runs` conta disparos da regra, mesmo quando as ações já estavam
    // satisfeitas — é a métrica que a tela de automações mostra.
    rule.runs += 1;
    outcomes.push({ rule: rule.name, actions: applied, events });
  }

  return outcomes;
}
