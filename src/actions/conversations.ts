"use server";

import { revalidatePath } from "next/cache";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { aiClassifyResponse } from "@/ai";
import { logActivity } from "@/services/lead-service";
import { emitEvent } from "@/services/events";

export async function sendMessage(conversationId: string, content: string): Promise<void> {
  if (!content.trim()) return;
  const db = getDb();
  const conv = db.conversations.find((c) => c.id === conversationId);
  if (!conv) return;
  const user = await getCurrentUser();

  db.messages.push({
    id: uid("msg"),
    conversation_id: conversationId,
    direction: "out",
    content: content.trim(),
    classification: null,
    created_at: nowIso(),
  });
  conv.last_message_at = nowIso();
  conv.unread = false;

  const lead = db.leads.find((l) => l.id === conv.lead_id);
  if (lead) {
    const isFirst = !lead.last_contact_at;
    lead.last_contact_at = nowIso();
    lead.updated_at = nowIso();
    logActivity(
      lead.id,
      isFirst ? "primeiro_contato" : "mensagem_enviada",
      `Mensagem enviada via ${conv.channel}`,
      user.id
    );
  }
  saveDb();
  revalidatePath("/conversas");
  // A mensagem atualiza `last_contact_at` e a timeline do lead.
  if (lead) {
    revalidatePath("/leads");
    revalidatePath(`/leads/${lead.id}`);
  }
}

/**
 * Simula o recebimento de uma resposta do lead (canal ainda não integrado).
 * Classifica com IA, pausa cadências e notifica — o mesmo fluxo que o
 * webhook do WhatsApp Business executará quando conectado.
 */
export async function simulateInbound(conversationId: string, content: string): Promise<void> {
  const actor = await getCurrentUser();
  if (!content.trim()) return;
  const db = getDb();
  const conv = db.conversations.find((c) => c.id === conversationId);
  if (!conv) return;

  const { output } = await aiClassifyResponse(content.trim());

  db.messages.push({
    id: uid("msg"),
    conversation_id: conversationId,
    direction: "in",
    content: content.trim(),
    classification: output.classification,
    created_at: nowIso(),
  });
  conv.last_message_at = nowIso();
  conv.unread = true;

  const lead = db.leads.find((l) => l.id === conv.lead_id);
  if (lead) {
    if (["contatado", "pronto_contato", "qualificado", "novo", "analisado"].includes(lead.status)) {
      lead.status = "respondeu";
      const stage = db.pipeline_stages.find((s) => s.name === "Respondeu");
      if (stage) {
        lead.pipeline_stage_id = stage.id;
        lead.stage_entered_at = nowIso();
      }
    }
    lead.updated_at = nowIso();
    logActivity(lead.id, "resposta_recebida", `Lead respondeu: "${content.trim().slice(0, 80)}"`, null);

    db.notifications.unshift({
      id: uid("ntf"),
      organization_id: db.organization.id,
      // Sem responsável definido, quem está operando recebe o aviso.
      user_id: lead.assigned_to ?? actor.id,
      title: `${lead.company_name} respondeu`,
      body: content.trim().slice(0, 100),
      link: `/conversas`,
      read: false,
      created_at: nowIso(),
    });
  }
  saveDb();

  // A pausa da cadência ao receber resposta é hoje uma automação ("Pausar
  // follow-ups automáticos"), não uma regra fixa no código: quem quiser
  // manter a cadência rodando pode desligá-la em /automacoes.
  if (lead) {
    emitEvent("lead.replied", lead, {
      payload: {
        message: content.trim(),
        classification: output.classification,
        conversation_id: conversationId,
      },
    });
    saveDb();
  }

  revalidatePath("/conversas");
  revalidatePath("/leads");
  revalidatePath("/tarefas");
  revalidatePath("/follow-ups");
  // A notificação criada aparece no sino da topbar, montada no layout.
  revalidatePath("/", "layout");
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await getCurrentUser();
  const db = getDb();
  const conv = db.conversations.find((c) => c.id === conversationId);
  if (conv?.unread) {
    conv.unread = false;
    saveDb();
    revalidatePath("/conversas");
  }
}
