import "server-only";
import type { AgentDefinition, PlannedTask } from "@/agents/types";
import { dayKey, spentToday } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { getAgentMode, getSellerConfig } from "@/services/agents/settings";
import { CONVERSATION_RESPOND } from "@/services/conversation/inbound";
import { registerConversationHandlers } from "@/services/conversation/respond";
import { firstTouchCandidates, OUTREACH_PREPARE, registerOutreachPrepareHandler } from "@/services/outreach/prepare";
import { isWhatsappGatewayConfigured } from "@/services/whatsapp/config";
import { getWhatsappLink } from "@/services/whatsapp/link";

/**
 * Agente 4 — Vendedor (WhatsApp).
 *
 * Escolhe quem abordar, confirma que o número tem WhatsApp, escreve a mensagem
 * e — conforme o modo — a entrega ao dono para aprovar ou a agenda. O envio em
 * si não é uma tarefa: é o processamento de ciclos (`services/outreach/send.ts`),
 * que o runner chama a cada passada e que obedece à política de envio.
 *
 * O modelo (ou o motor determinístico) só escreve texto. Quem decide se sai,
 * quando e para quem é código do servidor: janela, teto, intervalo, bloqueio,
 * aprovação e a autorização que o gateway exige.
 */

/** No máximo isto de rascunhos em preparo ao mesmo tempo: cada um gasta uma consulta ao WhatsApp. */
const MAX_LIVE_PREPARES = 3;

async function plan(): Promise<PlannedTask[]> {
  if (!isWhatsappGatewayConfigured()) return [];
  // Sem conexão não há como confirmar o número nem enviar: não vale preparar nada.
  if ((await getWhatsappLink())?.status !== "CONNECTED") return [];

  const [cfg, mode] = await Promise.all([getSellerConfig(), getAgentMode("seller")]);
  const repo = agentRepo();

  if (mode === "aprovacao") {
    const pending = (await repo.list("approvals", { where: { kind: "outreach_message", status: "pendente" } })).length;
    if (pending >= cfg.max_pending_approvals) return [];
  }
  if ((await spentToday("seller", "whatsapp_lookups")) >= cfg.lookups_per_day) return [];

  const live = (await repo.list("tasks", { where: { agent: "seller", kind: OUTREACH_PREPARE } })).filter((t) => t.status === "pendente" || t.status === "processando").length;
  const room = MAX_LIVE_PREPARES - live;
  if (room <= 0) return [];

  const leads = await firstTouchCandidates(cfg, room);
  return leads.map((lead) => ({
    agent: "seller" as const,
    kind: OUTREACH_PREPARE,
    payload: { lead_id: lead.id, touch: 1 },
    // Uma tentativa por lead por dia: um lead que não deu certo não é refeito a cada minuto.
    dedupeKey: `${OUTREACH_PREPARE}:${lead.id}:1:${dayKey()}`,
    title: `Preparar abordagem para ${lead.company_name}`,
    detail: `${lead.segment} · ${lead.city} · score ${lead.lead_score ?? "—"}`,
  }));
}

export const seller: AgentDefinition = {
  id: "seller",
  name: "Vendedor (WhatsApp)",
  description: "Escolhe quem abordar, confirma o WhatsApp do número, escreve a mensagem e a envia dentro da política de envio — com a sua aprovação enquanto você quiser.",
  kinds: [OUTREACH_PREPARE, CONVERSATION_RESPOND],
  direct: true,
  plan,
};

export function registerSellerHandlers() {
  registerOutreachPrepareHandler();
  registerConversationHandlers();
}
