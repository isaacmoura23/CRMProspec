import type { Activity, Database, Lead, LeadStatus } from "@/types";

/** Ordem do funil — um lead em "reuniao" já passou por "contatado" etc. */
const STATUS_RANK: Record<LeadStatus, number> = {
  novo: 0,
  analisado: 1,
  qualificado: 2,
  pronto_contato: 3,
  contatado: 4,
  respondeu: 5,
  interessado: 6,
  demo: 7,
  reuniao: 7,
  proposta: 8,
  negociacao: 8,
  fechado: 9,
  perdido: -1,
};

export function statusRank(status: LeadStatus): number {
  return STATUS_RANK[status];
}

export const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: "Novo",
  analisado: "Analisado",
  qualificado: "Qualificado",
  pronto_contato: "Pronto para contato",
  contatado: "Contatado",
  respondeu: "Respondeu",
  interessado: "Interessado",
  demo: "Demo",
  reuniao: "Reunião",
  proposta: "Proposta",
  negociacao: "Negociação",
  fechado: "Fechado",
  perdido: "Perdido",
};

export type Period = "hoje" | "7d" | "30d" | "mes" | "tudo";

export function periodStart(period: Period): Date | null {
  const now = new Date();
  switch (period) {
    case "hoje": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "7d":
      return new Date(now.getTime() - 7 * 86_400_000);
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000);
    case "mes": {
      return new Date(now.getFullYear(), now.getMonth(), 1);
    }
    case "tudo":
      return null;
  }
}

function inWindow(iso: string, start: Date | null, end: Date | null): boolean {
  const t = new Date(iso).getTime();
  if (start && t < start.getTime()) return false;
  if (end && t >= end.getTime()) return false;
  return true;
}

export interface KpiSet {
  encontrados: number;
  qualificados: number;
  contatados: number;
  respostas: number;
  interessados: number;
  reunioes: number;
  propostas: number;
  vendas: number;
  receita: number;
}

function countActivities(activities: Activity[], types: string[], start: Date | null, end: Date | null): number {
  return activities.filter((a) => types.includes(a.type) && inWindow(a.created_at, start, end)).length;
}

export function computeKpis(db: Database, start: Date | null, end: Date | null): KpiSet {
  const leadsIn = db.leads.filter((l) => !l.archived && inWindow(l.created_at, start, end));
  const acts = db.activities;
  const receita = db.leads
    .filter(
      (l) =>
        l.status === "fechado" &&
        l.potential_value &&
        inWindow(l.stage_entered_at ?? l.updated_at, start, end)
    )
    .reduce((acc, l) => acc + (l.potential_value ?? 0), 0);

  return {
    encontrados: leadsIn.length,
    qualificados: leadsIn.filter((l) => (l.lead_score ?? 0) >= db.settings.min_score).length,
    contatados: countActivities(acts, ["primeiro_contato", "mensagem_enviada"], start, end),
    respostas: countActivities(acts, ["resposta_recebida"], start, end),
    interessados: db.leads.filter(
      (l) => statusRank(l.status) >= 6 && l.status !== "perdido" && inWindow(l.updated_at, start, end)
    ).length,
    reunioes: countActivities(acts, ["reuniao"], start, end),
    propostas: countActivities(acts, ["proposta_enviada"], start, end),
    vendas: countActivities(acts, ["fechamento"], start, end),
    receita,
  };
}

export interface KpiWithTrend {
  key: keyof KpiSet;
  label: string;
  value: number;
  previous: number;
  isCurrency?: boolean;
}

export function computeKpisWithTrend(db: Database, period: Period): KpiWithTrend[] {
  const start = periodStart(period);
  const now = new Date();
  let prevStart: Date | null = null;
  let prevEnd: Date | null = null;
  if (start) {
    const span = now.getTime() - start.getTime();
    prevEnd = start;
    prevStart = new Date(start.getTime() - span);
  }
  const current = computeKpis(db, start, null);
  const previous = start ? computeKpis(db, prevStart, prevEnd) : ({} as KpiSet);

  const labels: Array<[keyof KpiSet, string, boolean?]> = [
    ["encontrados", "Leads encontrados"],
    ["qualificados", "Leads qualificados"],
    ["contatados", "Contatados"],
    ["respostas", "Respostas"],
    ["interessados", "Interessados"],
    ["reunioes", "Reuniões"],
    ["propostas", "Propostas enviadas"],
    ["vendas", "Vendas"],
    ["receita", "Receita gerada", true],
  ];

  return labels.map(([key, label, isCurrency]) => ({
    key,
    label,
    value: current[key],
    previous: previous[key] ?? 0,
    isCurrency,
  }));
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** taxa em relação à etapa anterior (%) */
  rate: number | null;
}

/** Funil acumulado: cada etapa conta leads que chegaram até ela (ou além). */
export function computeFunnel(db: Database): FunnelStage[] {
  const leads = db.leads.filter((l) => !l.archived);
  const stages: Array<[string, string, number]> = [
    ["encontrados", "Encontrados", 0],
    ["qualificados", "Qualificados", 2],
    ["contatados", "Contatados", 4],
    ["responderam", "Responderam", 5],
    ["interessados", "Interessados", 6],
    ["reuniao", "Reunião", 7],
    ["proposta", "Proposta", 8],
    ["fechados", "Fechados", 9],
  ];
  let prev: number | null = null;
  return stages.map(([key, label, minRank]) => {
    const count =
      minRank === 0
        ? leads.length
        : leads.filter((l) => statusRank(l.status) >= minRank).length;
    const rate = prev && prev > 0 ? Math.round((count / prev) * 1000) / 10 : null;
    prev = count;
    return { key, label, count, rate };
  });
}

export interface AttentionItem {
  label: string;
  detail: string;
  href: string;
  count: number;
  tone: "danger" | "warning" | "info" | "success";
}

export function computeAttention(db: Database): AttentionItem[] {
  const items: AttentionItem[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);

  const ready = db.leads.filter(
    (l) => !l.archived && (l.status === "pronto_contato" || l.status === "qualificado")
  );
  if (ready.length) {
    items.push({
      label: `${ready.length} ${ready.length === 1 ? "lead pronto" : "leads prontos"} para abordagem`,
      detail: "Qualificados aguardando o primeiro contato",
      href: "/leads?status=pronto_contato,qualificado",
      count: ready.length,
      tone: "success",
    });
  }

  const overdue = db.tasks.filter(
    (t) => !t.completed && t.type === "follow_up" && new Date(t.due_date) < today
  );
  if (overdue.length) {
    items.push({
      label: `${overdue.length} follow-ups vencidos`,
      detail: "Leads esfriando sem retomada",
      href: "/follow-ups",
      count: overdue.length,
      tone: "danger",
    });
  }

  const replied = db.conversations.filter((c) => c.unread);
  if (replied.length) {
    items.push({
      label: `${replied.length} ${replied.length === 1 ? "lead respondeu" : "leads responderam"}`,
      detail: "Respostas aguardando sua análise",
      href: "/conversas",
      count: replied.length,
      tone: "info",
    });
  }

  const meetingsToday = db.tasks.filter(
    (t) =>
      !t.completed &&
      t.type === "reuniao" &&
      new Date(t.due_date) >= today &&
      new Date(t.due_date) < tomorrow
  );
  if (meetingsToday.length) {
    items.push({
      label: `${meetingsToday.length} ${meetingsToday.length === 1 ? "reunião hoje" : "reuniões hoje"}`,
      detail: meetingsToday.map((t) => t.title).join(" · "),
      href: "/tarefas",
      count: meetingsToday.length,
      tone: "warning",
    });
  }

  const waitingProposals = db.proposals.filter(
    (p) => p.status === "enviada" || p.status === "visualizada"
  );
  if (waitingProposals.length) {
    items.push({
      label: `${waitingProposals.length} ${waitingProposals.length === 1 ? "proposta aguardando" : "propostas aguardando"} retorno`,
      detail: "Enviadas e ainda sem resposta",
      href: "/propostas",
      count: waitingProposals.length,
      tone: "warning",
    });
  }

  const hotNew = db.leads.filter(
    (l) =>
      !l.archived &&
      (l.lead_score ?? 0) >= 80 &&
      ["novo", "analisado", "qualificado", "pronto_contato"].includes(l.status)
  );
  if (hotNew.length) {
    items.push({
      label: `${hotNew.length} leads com score acima de 80`,
      detail: "Oportunidades quentes ainda não contatadas",
      href: "/leads?temperatura=quente",
      count: hotNew.length,
      tone: "success",
    });
  }

  return items;
}

export function bestOpportunities(db: Database, limit = 5): Lead[] {
  return db.leads
    .filter(
      (l) =>
        !l.archived &&
        l.status !== "fechado" &&
        l.status !== "perdido" &&
        (l.lead_score ?? 0) > 0
    )
    .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
    .slice(0, limit);
}
