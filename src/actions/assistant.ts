"use server";

import { getDb } from "@/lib/store";
import { daysSince } from "@/lib/format";
import { statusRank } from "@/services/stats";

/**
 * Assistente comercial: responde perguntas consultando os dados REAIS
 * do CRM. Nunca inventa informações — cada resposta é derivada de uma
 * consulta concreta e devolve os leads/números que a sustentam.
 */

export interface AssistantLead {
  id: string;
  company: string;
  segment: string;
  city: string;
  score: number | null;
  detail: string;
}

export interface AssistantReply {
  answer: string;
  leads?: AssistantLead[];
}

function extractNumber(q: string, fallback: number): number {
  const m = q.match(/(\d+)/);
  return m ? parseInt(m[1]!, 10) : fallback;
}

export async function askAssistant(question: string): Promise<AssistantReply> {
  const db = getDb();
  const q = question.toLowerCase();
  const active = db.leads.filter((l) => !l.archived);

  /* Leads para abordar hoje */
  if (/abordar|contatar|priorizar|come[cç]o o dia|hoje/.test(q) && /abordar|contatar|priorizar|come[cç]/.test(q)) {
    const ready = active
      .filter((l) => ["pronto_contato", "qualificado"].includes(l.status))
      .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
      .slice(0, 8);
    if (ready.length === 0) {
      return {
        answer:
          "Nenhum lead está marcado como qualificado ou pronto para contato agora. Rode uma nova prospecção ou qualifique leads analisados.",
      };
    }
    return {
      answer: `Encontrei ${ready.length} leads qualificados aguardando abordagem, ordenados por score. Comece pelos mais quentes:`,
      leads: ready.map((l) => ({
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        detail: l.next_follow_up_at ? "follow-up agendado" : "sem contato ainda",
      })),
    };
  }

  /* Score acima de N (com nicho opcional) */
  if (/score/.test(q)) {
    const min = extractNumber(q, 80);
    const nicheMatch = active.filter((l) => q.includes(l.segment.toLowerCase().split(" ")[0]!));
    const pool = nicheMatch.length > 0 ? nicheMatch : active;
    const result = pool
      .filter((l) => (l.lead_score ?? 0) >= min && l.status !== "fechado" && l.status !== "perdido")
      .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
      .slice(0, 10);
    return {
      answer:
        result.length === 0
          ? `Nenhum lead em aberto com score acima de ${min}${nicheMatch.length ? " nesse nicho" : ""}.`
          : `${result.length} leads em aberto com score ≥ ${min}:`,
      leads: result.map((l) => ({
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        detail: l.status.replace("_", " "),
      })),
    };
  }

  /* Disseram que não era prioridade */
  if (/prioridade|depois|futuro|mais pra frente/.test(q)) {
    const convIds = new Map(db.conversations.map((c) => [c.id, c.lead_id]));
    const leadIds = new Set(
      db.messages
        .filter((m) => m.direction === "in" && ["sem_prioridade", "pediu_retorno_futuro"].includes(m.classification ?? ""))
        .map((m) => convIds.get(m.conversation_id))
        .filter(Boolean)
    );
    const result = active.filter((l) => leadIds.has(l.id));
    return {
      answer:
        result.length === 0
          ? "Nenhum prospect classificado como “sem prioridade” ou “pediu retorno futuro” até agora."
          : `${result.length} prospects disseram que não era prioridade ou pediram retorno futuro:`,
      leads: result.map((l) => ({
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        detail: l.next_follow_up_at ? "follow-up agendado" : "sem follow-up marcado",
      })),
    };
  }

  /* Sem follow-up há mais de X dias */
  if (/follow.?up|sem contato|parado|esfriando|abandonado/.test(q)) {
    const days = extractNumber(q, 5);
    const result = active
      .filter(
        (l) =>
          l.last_contact_at &&
          daysSince(l.last_contact_at) > days &&
          !l.next_follow_up_at &&
          !["fechado", "perdido"].includes(l.status)
      )
      .sort((a, b) => (a.last_contact_at ?? "").localeCompare(b.last_contact_at ?? ""));
    return {
      answer:
        result.length === 0
          ? `Nenhum lead contatado está há mais de ${days} dias sem follow-up agendado. Operação em dia!`
          : `${result.length} leads estão há mais de ${days} dias sem follow-up:`,
      leads: result.map((l) => ({
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        detail: `último contato há ${daysSince(l.last_contact_at!)} dias`,
      })),
    };
  }

  /* Campanhas */
  if (/campanha/.test(q)) {
    const rows = db.campaigns
      .filter((c) => !c.archived)
      .map((c) => {
        const leads = active.filter((l) => l.campaign_id === c.id);
        const contacted = leads.filter((l) => statusRank(l.status) >= 4).length;
        const replied = leads.filter((l) => statusRank(l.status) >= 5).length;
        const won = leads.filter((l) => l.status === "fechado").length;
        const rate = contacted > 0 ? Math.round((replied / contacted) * 100) : 0;
        return `• ${c.name}: ${leads.length} leads, ${contacted} contatados, ${replied} responderam (${rate}% de resposta), ${won} vendas`;
      });
    return {
      answer:
        rows.length === 0
          ? "Nenhuma campanha criada ainda. Crie uma ao iniciar uma prospecção."
          : `Desempenho real das campanhas:\n\n${rows.join("\n")}`,
    };
  }

  /* Respostas não lidas */
  if (/responderam|respostas|inbox|mensagens/.test(q)) {
    const unread = db.conversations.filter((c) => c.unread);
    const result = active.filter((l) => unread.some((c) => c.lead_id === l.id));
    return {
      answer:
        result.length === 0
          ? "Nenhuma resposta aguardando leitura."
          : `${result.length} leads responderam e aguardam sua análise:`,
      leads: result.map((l) => ({
        id: l.id,
        company: l.company_name,
        segment: l.segment,
        city: l.city,
        score: l.lead_score,
        detail: "resposta não lida",
      })),
    };
  }

  /* Resumo geral (fallback) */
  const open = active.filter((l) => !["fechado", "perdido"].includes(l.status));
  const hot = open.filter((l) => (l.lead_score ?? 0) >= 80).length;
  const overdue = db.tasks.filter(
    (t) => !t.completed && t.type === "follow_up" && new Date(t.due_date) < new Date()
  ).length;
  return {
    answer: `Resumo da operação: ${open.length} leads em aberto (${hot} quentes com score 80+), ${overdue} follow-ups vencidos e ${db.conversations.filter((c) => c.unread).length} respostas não lidas.

Você pode me perguntar coisas como:
• "Quais leads devo abordar hoje?"
• "Mostre imobiliárias com score acima de 80"
• "Quais prospects disseram que não era prioridade?"
• "Quais leads estão sem follow-up há mais de 5 dias?"
• "Quais campanhas estão convertendo melhor?"`,
  };
}
