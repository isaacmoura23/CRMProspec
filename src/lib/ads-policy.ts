import { normalizeText } from "@/lib/conversation-policy";
import { formatBrl as brl } from "@/lib/money";
import { validatePublicUrl } from "@/lib/safe-url";
import type { AdCampaign, AdCampaignStatus } from "@/types/agents";

/**
 * Regras puras de campanhas de anúncio — testáveis sem servidor.
 *
 * Duas garantias moram aqui, em código e não em texto de prompt:
 *   1. dinheiro só se move com clique **dentro dos tetos** (`evaluateSpendCaps`);
 *   2. o agente nunca chega a "ativa" nem aumenta orçamento: a máquina de estados
 *      deixa "aprovado → ativa" e o aumento de orçamento para a ação do botão.
 * Todo valor em centavos.
 */

export const MAX_DAILY_BUDGET_CENTS = 10_000_000;

export const CAMPAIGN_TRANSITIONS: Record<AdCampaignStatus, AdCampaignStatus[]> = {
  rascunho: ["pendente", "recusada", "expirada"],
  pendente: ["aprovado", "recusada", "expirada"],
  // Ativar é a passagem protegida: só a ação do botão, e só dentro dos tetos.
  aprovado: ["ativa", "encerrada", "falhou"],
  ativa: ["pausada", "encerrada", "falhou"],
  pausada: ["ativa", "encerrada"],
  encerrada: [],
  recusada: [],
  expirada: [],
  falhou: ["pendente", "encerrada"],
};

export function canMoveCampaign(from: AdCampaignStatus, to: AdCampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

const PROMISES = /\bgarant(ido|imos|ia)\b|100\s?%|sem risco|resultado garantido|dinheiro de volta|lucro certo|o melhor do (brasil|mundo)|cura\b|milagr|emagre[cç]a|ganhe dinheiro/i;

export interface CampaignDraft {
  name: string;
  headline: string;
  body: string;
  cta: string;
  audience: string;
  daily_budget_cents: number;
  start_date: string;
  end_date: string | null;
  landing_url: string | null;
}

/** Barreiras da campanha. Devolve o motivo da recusa, ou `null`. */
export function checkCampaign(c: CampaignDraft, neverSay: readonly string[] = [], today: string = new Date().toISOString().slice(0, 10)): string | null {
  if (c.name.trim().length < 3) return "A campanha precisa de um nome.";
  if (!Number.isInteger(c.daily_budget_cents) || c.daily_budget_cents <= 0) return "O orçamento diário precisa ser maior que zero.";
  if (c.daily_budget_cents > MAX_DAILY_BUDGET_CENTS) return "Orçamento diário alto demais.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start_date)) return "Data de início inválida.";
  if (c.start_date < today) return "A campanha não pode começar no passado.";
  if (c.end_date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(c.end_date) || c.end_date < c.start_date)) return "A data final precisa ser depois da inicial.";
  if (c.headline.trim().length < 3 || c.headline.length > 40) return "O título precisa ter de 3 a 40 caracteres.";
  if (c.body.trim().length < 20 || c.body.length > 300) return "O texto do anúncio precisa ter de 20 a 300 caracteres.";
  if (c.cta.trim().length < 3 || c.cta.length > 30) return "A chamada para ação precisa ter de 3 a 30 caracteres.";
  if (c.landing_url) {
    const v = validatePublicUrl(c.landing_url);
    if (!v.ok) return `Endereço de destino não aceito: ${v.reason}.`;
    if (v.url.protocol !== "https:") return "O endereço de destino precisa ser https.";
  }
  const text = `${c.headline} ${c.body} ${c.cta}`;
  if (PROMISES.test(text)) return "Promessa de resultado não é permitida em anúncio.";
  if (/\{\{|\}\}|\[(nome|empresa|cidade)\]|undefined|null\b/i.test(text)) return "Texto com variável não preenchida.";
  const lower = normalizeText(text);
  for (const phrase of neverSay) {
    const p = normalizeText(phrase);
    if (p.length >= 4 && lower.includes(p)) return `Contém uma frase proibida pelo perfil da empresa: "${phrase}".`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Tetos de gasto                                                      */
/* ------------------------------------------------------------------ */

export interface SpendCapInput {
  /** Orçamento diário da campanha que será ativada (ou o novo valor, num aumento). */
  campaignDailyCents: number;
  /** Soma dos orçamentos diários das OUTRAS campanhas já ativas. */
  otherActiveDailyCents: number;
  /** Quanto já foi gasto neste mês (relatórios). */
  spentMonthCents: number;
  /** Hoje, no fuso do negócio (YYYY-MM-DD). */
  today: string;
  /** Data final da campanha (limita os dias que ela ainda vai gastar). */
  endDate?: string | null;
  caps: { daily_cap_cents: number; monthly_cap_cents: number };
}

export type SpendCapResult = { ok: true; projectedMonthCents: number } | { ok: false; code: "diario" | "mensal"; reason: string };


/** Dias que faltam no mês, contando hoje. */
export function remainingDaysInMonth(today: string, endDate?: string | null): number {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let end = last;
  if (endDate && endDate.slice(0, 7) === today.slice(0, 7)) end = Math.min(last, Number(endDate.slice(8, 10)));
  return Math.max(0, end - d + 1);
}

/** Pode ativar (ou aumentar) sem passar dos tetos? */
export function evaluateSpendCaps(i: SpendCapInput): SpendCapResult {
  const dailyTotal = i.otherActiveDailyCents + i.campaignDailyCents;
  if (dailyTotal > i.caps.daily_cap_cents) {
    return { ok: false, code: "diario", reason: `O gasto diário somaria ${brl(dailyTotal)}, acima do teto de ${brl(i.caps.daily_cap_cents)} por dia.` };
  }
  const days = remainingDaysInMonth(i.today, i.endDate);
  const otherDays = remainingDaysInMonth(i.today);
  const projected = i.spentMonthCents + i.otherActiveDailyCents * otherDays + i.campaignDailyCents * days;
  if (projected > i.caps.monthly_cap_cents) {
    return { ok: false, code: "mensal", reason: `O gasto do mês chegaria a ${brl(projected)} (já gasto mais o previsto), acima do teto de ${brl(i.caps.monthly_cap_cents)} por mês.` };
  }
  return { ok: true, projectedMonthCents: projected };
}

/** Esta mudança move dinheiro para cima (e por isso exige clique E teto)? */
export function increasesSpend(from: Pick<AdCampaign, "status" | "daily_budget_cents">, to: { status?: AdCampaignStatus; daily_budget_cents?: number }): boolean {
  const activating = to.status === "ativa" && from.status !== "ativa";
  const raising = to.daily_budget_cents !== undefined && to.daily_budget_cents > from.daily_budget_cents;
  return activating || raising;
}

export { formatBrl } from "@/lib/money";
