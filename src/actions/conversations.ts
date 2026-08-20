"use server";

import { revalidatePath } from "next/cache";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { aiClassifyResponse } from "@/ai";
import { logActivity } from "@/services/lead-service";

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
}

/**
 * Simula o recebimento de uma resposta do lead (canal ainda não integrado).
 * Classifica com IA, pausa cadências e notifica — o mesmo fluxo que o
 * webhook do WhatsApp Business executará quando conectado.
 */
export async function simulateInbound(conversationId: string, content: string): Promise<void> {
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
    // resposta recebida → pausa follow-ups automáticos pendentes
    lead.next_follow_up_at = null;
    lead.updated_at = nowIso();
    logActivity(lead.id, "resposta_recebida", `Lead respondeu: "${content.trim().slice(0, 80)}"`, null);

    db.notifications.unshift({
      id: uid("ntf"),
      organization_id: db.organization.id,
      user_id: lead.assigned_to ?? db.users[0]!.id,
      title: `${lead.company_name} respondeu`,
      body: content.trim().slice(0, 100),
      link: `/conversas`,
      read: false,
      created_at: nowIso(),
    });
  }
  saveDb();
  revalidatePath("/conversas");
  revalidatePath("/leads");
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const db = getDb();
  const conv = db.conversations.find((c) => c.id === conversationId);
  if (conv?.unread) {
    conv.unread = false;
    saveDb();
    revalidatePath("/conversas");
  }
}
