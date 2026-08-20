"use server";

import { revalidatePath } from "next/cache";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { aiClassifyResponse, aiGenerateOutreach, aiHandleObjection } from "@/ai";
import { logActivity } from "@/services/lead-service";
import { CLASSIFICATION_LABEL } from "@/ai/schemas";
import type { AIGeneration, MessageFormat, MessageTone } from "@/types";

export async function generateOutreach(
  leadId: string,
  format: MessageFormat,
  tone: MessageTone,
  variant: number
): Promise<{ generation: AIGeneration } | { error: string }> {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return { error: "Lead não encontrado." };

  const analysis = db.lead_analysis.find((a) => a.lead_id === leadId);
  if (!analysis) {
    return { error: "Analise a oportunidade antes de gerar a abordagem — a mensagem usa o problema identificado." };
  }

  const user = await getCurrentUser();
  const followUpContext =
    format === "follow_up"
      ? db.messages
          .filter((m) => {
            const conv = db.conversations.find((c) => c.id === m.conversation_id);
            return conv?.lead_id === leadId && m.direction === "in";
          })
          .at(-1)?.content
      : undefined;

  try {
    const { content, model } = await aiGenerateOutreach(
      lead,
      analysis,
      db.company_profile,
      format,
      tone,
      variant,
      followUpContext
    );

    const generation: AIGeneration = {
      id: uid("gen"),
      lead_id: leadId,
      kind: format === "audio" ? "audio" : format === "follow_up" ? "follow_up" : "abordagem",
      format,
      tone,
      content,
      model,
      saved: false,
      created_at: nowIso(),
    };
    db.ai_generations.push(generation);
    logActivity(leadId, "mensagem_gerada", `Abordagem gerada (${format})`, user.id);
    saveDb();
    return { generation };
  } catch (err) {
    console.error("[ai] geração falhou:", err);
    return { error: "Não conseguimos gerar a mensagem agora. Tente novamente." };
  }
}

export async function saveGeneration(generationId: string): Promise<void> {
  const db = getDb();
  const gen = db.ai_generations.find((g) => g.id === generationId);
  if (gen) {
    gen.saved = true;
    saveDb();
  }
}

/** Registra que o primeiro contato / uma mensagem foi enviada manualmente */
export async function registerContactMade(leadId: string, channel: string): Promise<void> {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return;
  const user = await getCurrentUser();
  const isFirst = !lead.last_contact_at;
  lead.last_contact_at = nowIso();
  if (["novo", "analisado", "qualificado", "pronto_contato"].includes(lead.status)) {
    lead.status = "contatado";
    const stage = db.pipeline_stages.find((s) => s.name === "Contatado");
    if (stage) {
      lead.pipeline_stage_id = stage.id;
      lead.stage_entered_at = nowIso();
    }
  }
  lead.updated_at = nowIso();
  logActivity(
    leadId,
    isFirst ? "primeiro_contato" : "mensagem_enviada",
    `${isFirst ? "Primeira abordagem" : "Mensagem"} enviada por ${channel}`,
    user.id
  );
  saveDb();
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

export async function classifyIncoming(
  messageId: string
): Promise<{ label: string } | { error: string }> {
  const db = getDb();
  const msg = db.messages.find((m) => m.id === messageId);
  if (!msg) return { error: "Mensagem não encontrada." };
  const { output } = await aiClassifyResponse(msg.content);
  msg.classification = output.classification;
  saveDb();
  revalidatePath("/conversas");
  return { label: CLASSIFICATION_LABEL[output.classification] };
}

export async function suggestObjectionResponse(
  leadId: string,
  objection: string
): Promise<{ suggestion: string } | { error: string }> {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return { error: "Lead não encontrado." };
  const analysis = db.lead_analysis.find((a) => a.lead_id === leadId);
  const context = `Lead: ${lead.company_name} (${lead.segment}). ${analysis ? `Problema identificado: ${analysis.main_problem}` : ""}`;
  const { content } = await aiHandleObjection(objection, context, db.company_profile);
  return { suggestion: content };
}
