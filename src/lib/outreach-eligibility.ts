import { isBrazilianMobile, normalizeBrazilianPhone, phoneKey } from "@/lib/outreach-policy";
import type { SellerConfig } from "@/agents/config";
import type { Lead, LeadStatus } from "@/types";
import type { Approval, OutreachCycle } from "@/types/agents";

/**
 * Quem pode receber uma abordagem — regras puras, testáveis sem servidor.
 *
 * A pergunta aqui é "este lead PODE ser abordado agora?". O que decide se uma
 * mensagem específica sai (janela, teto, intervalo, conexão) mora no envio.
 */

/** Primeira abordagem só a quem ainda não foi tocado. */
export const FIRST_TOUCH_STATUSES: readonly LeadStatus[] = ["novo", "analisado", "qualificado", "pronto_contato"];
/** Acompanhamento só a quem foi contatado e ficou em silêncio: respondeu, interessou, perdeu… sai do ciclo. */
export const FOLLOW_UP_STATUSES: readonly LeadStatus[] = ["contatado"];

/**
 * Telefone que dá para abordar: celular brasileiro (fixo quase nunca tem
 * WhatsApp, então nem se gasta uma consulta), preferindo o WhatsApp que o site
 * da empresa publica.
 */
export function contactablePhone(lead: Pick<Lead, "whatsapp" | "phone">): string | null {
  for (const raw of [lead.whatsapp, lead.phone]) {
    const e164 = normalizeBrazilianPhone(raw);
    if (e164 && isBrazilianMobile(e164)) return e164;
  }
  return null;
}

/** Fontes cujo "nome do contato" já foi (ou pode ter sido) inventado. */
const FAKE_CONTACT_SOURCES = new Set(["google_places", "diretorio", "demo"]);

/**
 * Cópia do lead segura para escrever uma mensagem.
 *
 * Antes da correção em `createLeadFromRaw`, todo lead novo — inclusive os
 * reais do Google Maps — recebia um primeiro nome aleatório como "contato".
 * Leads antigos continuam com esse nome no banco, e usá-lo faria a mensagem
 * cumprimentar um estranho pelo nome errado. O nome só vale quando veio de uma
 * pessoa (cadastro manual, CSV, webhook).
 */
export function leadForMessage<T extends Pick<Lead, "contact_name" | "source">>(lead: T): T {
  return FAKE_CONTACT_SOURCES.has(lead.source) ? { ...lead, contact_name: null } : lead;
}

export interface EligibilityInput {
  lead: Lead;
  touch: number;
  cfg: SellerConfig;
  /** Chaves (só dígitos) da lista de bloqueio. */
  blocked: ReadonlySet<string>;
  /** Ciclos DESTE lead. */
  cycles: readonly OutreachCycle[];
  /** Pedidos de aprovação de mensagem DESTE lead. */
  approvals: readonly Approval[];
  /** Campanhas criadas pelos agentes; `null` = não restringir. */
  agentCampaignIds: ReadonlySet<string> | null;
  /** Você assumiu a conversa deste lead: o agente não escreve mais nela. */
  humanControl?: boolean;
}

/** Devolve por que o lead NÃO pode ser abordado agora, ou `null` se pode. */
export function leadEligibility(i: EligibilityInput): string | null {
  const { lead, touch, cfg } = i;

  if (lead.archived) return "lead arquivado";
  if (i.humanControl) return "conversa assumida por você";
  if (touch < 1 || touch > cfg.max_touches) return "limite de toques atingido";
  const allowed = touch === 1 ? FIRST_TOUCH_STATUSES : FOLLOW_UP_STATUSES;
  if (!allowed.includes(lead.status)) return `status "${lead.status}" não recebe ${touch === 1 ? "primeira abordagem" : "acompanhamento"}`;

  if (cfg.only_agent_leads && !(lead.campaign_id && i.agentCampaignIds?.has(lead.campaign_id))) return "não é um lead criado pelos agentes";
  if ((lead.lead_score ?? 0) < cfg.min_lead_score) return "score abaixo do mínimo";

  const phone = contactablePhone(lead);
  if (!phone) return "sem celular com WhatsApp provável";
  if (i.blocked.has(phoneKey(phone))) return "número na lista de bloqueio";

  if (i.cycles.some((c) => c.status === "agendado" || c.status === "reivindicado")) return "já há uma abordagem em andamento";
  // Envio sem confirmação pode ter chegado: ninguém manda outro por cima antes de conferir.
  if (i.cycles.some((c) => c.status === "incerto")) return "há um envio sem confirmação aguardando conferência";
  if (i.cycles.some((c) => c.touch === touch && c.status === "enviado")) return "este toque já foi enviado";

  if (touch > 1) {
    const previous = i.cycles.find((c) => c.touch === touch - 1);
    if (previous?.status !== "enviado") return "o toque anterior não foi enviado";
  }

  // Pedido pendente, aprovado ou recusado para este toque: não se repete. Só o
  // que expirou sem resposta pode ser proposto de novo.
  if (i.approvals.some((a) => a.status !== "expirado" && Number((a.payload as { touch?: number }).touch) === touch)) {
    return "já há um pedido de aprovação para este toque";
  }
  return null;
}
