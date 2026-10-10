import "server-only";
import { uid } from "@/lib/utils";
import type { PlannedTask } from "@/agents/types";
import { checkReply } from "@/lib/conversation-policy";
import { checkMessage, withOptOutFooter } from "@/lib/outreach-policy";
import { getDb } from "@/lib/store";
import { applyBudgetChange, approveCampaignDraft, rejectCampaignDraft } from "@/services/ads/campaigns";
import { rejectPost } from "@/services/social/posts";
import { logAgentEvent } from "@/services/agents/log";
import { createOutreachCycle } from "@/services/outreach/cycles";
import { enqueueAgentTask } from "@/services/agents/queue";
import { agentRepo, orgId } from "@/services/agents/repository";
import type { AgentId, AgentMode, Approval } from "@/types/agents";

/**
 * Fila de aprovação.
 *
 * No modo `aprovacao`, o que o agente decide iniciar sozinho não executa: vira
 * um pedido aqui. O clique do dono é o que enfileira a tarefa. Pedidos não
 * decididos expiram — uma proposta de três dias atrás já não reflete o estado.
 */

export const APPROVAL_TTL_MS = 3 * 86_400_000;

export type SubmitOutcome = "enqueued" | "approval" | "skipped";

/**
 * Entrega uma tarefa planejada conforme o modo do agente.
 *
 * A chave de dedupe é consultada em tarefas e pedidos de qualquer estado:
 * uma proposta recusada ou uma tarefa que falhou hoje não volta a ser
 * proposta no mesmo dia.
 */
export async function submitPlannedTask(planned: PlannedTask, mode: AgentMode): Promise<SubmitOutcome> {
  if (mode === "pausado") return "skipped";
  const repo = agentRepo();

  const [tasks, approvals] = await Promise.all([
    repo.list("tasks", { where: { dedupe_key: planned.dedupeKey } }),
    repo.list("approvals", { where: { dedupe_key: planned.dedupeKey } }),
  ]);
  if (tasks.length > 0 || approvals.length > 0) return "skipped";

  if (mode === "automatico") {
    const { created } = await enqueueAgentTask({
      agent: planned.agent,
      kind: planned.kind,
      payload: planned.payload,
      dedupeKey: planned.dedupeKey,
    });
    if (created) {
      await logAgentEvent(planned.agent, "info", "plan.enqueued", `Iniciou sozinho: ${planned.title}.`, planned.payload);
    }
    return created ? "enqueued" : "skipped";
  }

  const now = Date.now();
  const approval: Approval = {
    id: uid("apv"),
    organization_id: orgId(),
    agent: planned.agent,
    kind: "agent_task",
    title: planned.title,
    detail: planned.detail,
    payload: {
      agent: planned.agent,
      kind: planned.kind,
      payload: planned.payload,
      dedupeKey: planned.dedupeKey,
    },
    dedupe_key: planned.dedupeKey,
    status: "pendente",
    decided_by: null,
    decided_at: null,
    task_id: null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
  };
  await repo.insert("approvals", approval);
  await logAgentEvent(planned.agent, "info", "approval.requested", `Pediu aprovação: ${planned.title}.`);
  return "approval";
}

export type DecisionResult = { ok: true; approval: Approval } | { ok: false; error: string };

export async function decideApproval(id: string, approve: boolean, userId: string, opts: { editedBody?: string } = {}): Promise<DecisionResult> {
  const repo = agentRepo();
  const approval = await repo.get("approvals", id);
  if (!approval) return { ok: false, error: "Pedido não encontrado." };
  if (approval.status !== "pendente") return { ok: false, error: "Este pedido já foi decidido." };

  const now = new Date().toISOString();
  if (approval.expires_at < now) {
    const expired = await repo.update("approvals", id, { status: "expirado", decided_at: now });
    return { ok: false, error: expired ? "Este pedido expirou. O agente fará uma nova proposta." : "Pedido não encontrado." };
  }

  if (!approve) {
    // Recusar também encerra a coisa por trás do pedido (o post, a campanha).
    const target = (approval.payload as { post_id?: string; campaign_id?: string });
    if (approval.kind === "social_post" && target.post_id) await rejectPost(target.post_id, userId);
    if (approval.kind === "ad_campaign" && target.campaign_id) await rejectCampaignDraft(target.campaign_id, userId);
    const updated = await repo.update("approvals", id, { status: "recusado", decided_by: userId, decided_at: now });
    await logAgentEvent(approval.agent, "info", "approval.rejected", `Recusado: ${approval.title}.`);
    return { ok: true, approval: updated ?? approval };
  }

  // Mensagem de WhatsApp: aprovar cria o ciclo de envio com o texto exato (editado ou não).
  if (approval.kind === "outreach_message") return approveOutreachMessage(approval, userId, now, opts.editedBody);
  if (approval.kind === "conversation_reply") return approveConversationReply(approval, userId, now, opts.editedBody);
  // Publicar no Instagram não passa por aqui: só o botão "Aprovar e publicar" do post (que também confere a imagem).
  if (approval.kind === "social_post") return { ok: false, error: "Para um post, use “Aprovar e publicar” no próprio post: ele confere a imagem e publica no mesmo clique." };
  if (approval.kind === "ad_campaign") {
    const campaignId = (approval.payload as { campaign_id?: string }).campaign_id;
    if (!campaignId) return { ok: false, error: "Pedido sem campanha." };
    const r = await approveCampaignDraft(campaignId, userId, new Date(now));
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, approval: (await repo.get("approvals", id)) ?? approval };
  }
  if (approval.kind === "ad_budget_change") {
    const r = await applyBudgetChange(approval.payload as { campaign_id: string; action: string; to_cents: number | null }, userId, new Date(now));
    if (!r.ok) return { ok: false, error: r.error };
    const updated = await repo.update("approvals", id, { status: "aprovado", decided_by: userId, decided_at: now });
    await logAgentEvent("traffic-manager", "info", "approval.approved", `Aprovado: ${approval.title}`);
    return { ok: true, approval: updated ?? approval };
  }

  const spec = approval.payload as { agent?: AgentId; kind?: string; payload?: Record<string, unknown>; dedupeKey?: string };
  if (!spec.agent || !spec.kind) return { ok: false, error: "Pedido sem tarefa associada." };
  const { task } = await enqueueAgentTask({
    agent: spec.agent,
    kind: spec.kind,
    payload: spec.payload ?? {},
    // A chave do pedido já está ocupada por ele mesmo; a tarefa leva outra.
    dedupeKey: spec.dedupeKey ? `${spec.dedupeKey}:aprovado` : null,
    createdBy: userId,
  });
  const updated = await repo.update("approvals", id, {
    status: "aprovado",
    decided_by: userId,
    decided_at: now,
    task_id: task.id,
  });
  await logAgentEvent(approval.agent, "info", "approval.approved", `Aprovado: ${approval.title}.`, null, task.id);
  return { ok: true, approval: updated ?? approval };
}

/**
 * Aprovar uma mensagem não a envia: entrega ao envio um ciclo com o texto exato.
 * Janela, teto, intervalo, bloqueio e conexão ainda decidem quando (e se) sai —
 * a aprovação do dono é uma condição, não um atalho.
 */
async function approveOutreachMessage(approval: Approval, userId: string, now: string, editedBody?: string): Promise<DecisionResult> {
  const repo = agentRepo();
  const p = approval.payload as { lead_id?: string; touch?: number; phone?: string; body?: string };
  if (!p.lead_id || !p.phone || !p.body) return { ok: false, error: "Pedido sem os dados da mensagem." };

  // Texto editado pelo dono passa pelas mesmas barreiras do gerado (e o aviso de saída volta, se ele o apagou).
  const edited = editedBody !== undefined && editedBody.trim() !== p.body.trim();
  const body = edited ? withOptOutFooter(editedBody!) : p.body;
  if (edited) {
    const violation = checkMessage(body);
    if (violation) return { ok: false, error: violation };
  }

  const cycle = await createOutreachCycle({ leadId: p.lead_id, touch: p.touch ?? 1, phone: p.phone, body, approvalId: approval.id });
  if (!cycle) return { ok: false, error: "Este lead já tem uma abordagem em andamento." };

  const updated = await repo.update("approvals", approval.id, {
    status: "aprovado",
    decided_by: userId,
    decided_at: now,
    payload: { ...approval.payload, body, edited },
  });
  await logAgentEvent("seller", "info", "approval.approved", `Aprovado${edited ? " (com edição)" : ""}: ${approval.title}.`, { cycle_id: cycle.id });
  return { ok: true, approval: updated ?? approval };
}

/**
 * Aprovar uma resposta ao lead cria o ciclo de envio (toque 0) com o texto exato.
 * Janela, intervalo, bloqueio e conexão ainda decidem quando sai.
 */
async function approveConversationReply(approval: Approval, userId: string, now: string, editedBody?: string): Promise<DecisionResult> {
  const repo = agentRepo();
  const p = approval.payload as { lead_id?: string; phone?: string; body?: string };
  if (!p.lead_id || !p.phone || !p.body) return { ok: false, error: "Pedido sem os dados da resposta." };

  const edited = editedBody !== undefined && editedBody.trim() !== p.body.trim();
  const body = edited ? editedBody!.trim() : p.body;
  if (edited) {
    const violation = checkReply(body, getDb().company_profile.never_say);
    if (violation) return { ok: false, error: violation };
  }

  const cycle = await createOutreachCycle({ leadId: p.lead_id, kind: "resposta", touch: 0, phone: p.phone, body, approvalId: approval.id });
  if (!cycle) return { ok: false, error: "Este lead já tem um envio em andamento." };

  const updated = await repo.update("approvals", approval.id, {
    status: "aprovado",
    decided_by: userId,
    decided_at: now,
    payload: { ...approval.payload, body, edited },
  });
  await logAgentEvent("seller", "info", "approval.approved", `Aprovado${edited ? " (com edição)" : ""}: ${approval.title}.`, { cycle_id: cycle.id });
  return { ok: true, approval: updated ?? approval };
}

/** Marca como expirados os pedidos antigos sem decisão. */
export async function expireApprovals(): Promise<number> {
  const repo = agentRepo();
  const now = new Date().toISOString();
  const pending = await repo.list("approvals", { where: { status: "pendente" } });
  let n = 0;
  for (const a of pending) {
    if (a.expires_at < now) {
      await repo.update("approvals", a.id, { status: "expirado", decided_at: now });
      n += 1;
    }
  }
  return n;
}
