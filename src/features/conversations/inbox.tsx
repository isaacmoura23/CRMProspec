"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, MessageCircle, Send, Sparkles, TestTube2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/ui/avatar";
import { ScoreBadge } from "@/components/score-badge";
import { useToast } from "@/components/ui/toast";
import { markConversationRead, sendMessage, simulateInbound } from "@/actions/conversations";
import { suggestObjectionResponse } from "@/actions/ai";
import { CLASSIFICATION_LABEL } from "@/ai/schemas";
import { STATUS_LABEL } from "@/services/stats";
import { formatCurrency, formatDateTime, timeAgo } from "@/lib/format";
import type { Conversation, Lead, Message, PipelineStage, User } from "@/types";
import { cn } from "@/lib/utils";

export interface InboxData {
  conversations: Conversation[];
  messages: Message[];
  leads: Lead[];
  users: User[];
  stages: PipelineStage[];
}

export function Inbox({ data, currency }: { data: InboxData; currency: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const sorted = [...data.conversations].sort((a, b) =>
    b.last_message_at.localeCompare(a.last_message_at)
  );
  const [activeId, setActiveId] = React.useState<string | null>(sorted[0]?.id ?? null);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [suggesting, setSuggesting] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const active = data.conversations.find((c) => c.id === activeId);
  const lead = active ? data.leads.find((l) => l.id === active.lead_id) : undefined;
  const messages = active
    ? data.messages
        .filter((m) => m.conversation_id === active.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    : [];
  const lastInbound = [...messages].reverse().find((m) => m.direction === "in");

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    if (active?.unread) void markConversationRead(active.id);
  }, [activeId, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSend() {
    if (!active || !draft.trim()) return;
    setSending(true);
    try {
      await sendMessage(active.id, draft);
      setDraft("");
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  async function handleSuggest() {
    if (!lead || !lastInbound) return;
    setSuggesting(true);
    try {
      const res = await suggestObjectionResponse(lead.id, lastInbound.content);
      if ("error" in res) toast(res.error, "error");
      else setDraft(res.suggestion);
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="grid min-h-[70vh] grid-cols-1 overflow-hidden rounded-xl border border-border bg-surface shadow-card lg:grid-cols-[280px_1fr_260px]">
      {/* Lista de conversas */}
      <div className="border-b border-border lg:border-b-0 lg:border-r">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Conversas</h3>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {sorted.map((conv) => {
            const l = data.leads.find((x) => x.id === conv.lead_id);
            const last = [...data.messages]
              .filter((m) => m.conversation_id === conv.id)
              .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
            return (
              <button
                key={conv.id}
                onClick={() => setActiveId(conv.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b border-border px-4 py-3 text-left transition-colors cursor-pointer",
                  activeId === conv.id ? "bg-primary-soft/40" : "hover:bg-surface-hover"
                )}
              >
                <Avatar name={l?.company_name ?? "?"} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("truncate text-[13px]", conv.unread ? "font-semibold" : "font-medium")}>
                      {l?.company_name ?? "Lead"}
                    </span>
                    <span className="shrink-0 text-[10px] text-faint-foreground">
                      {timeAgo(conv.last_message_at)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    {conv.channel === "whatsapp" ? (
                      <MessageCircle className="size-3 shrink-0 text-primary" />
                    ) : (
                      <Mail className="size-3 shrink-0 text-info" />
                    )}
                    <span className="truncate text-xs text-muted-foreground">{last?.content}</span>
                    {conv.unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Chat */}
      <div className="flex flex-col">
        {!active || !lead ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <Link href={`/leads/${lead.id}`} className="text-sm font-semibold hover:text-primary">
                {lead.company_name}
              </Link>
              <Badge variant="neutral">{active.channel === "whatsapp" ? "WhatsApp" : "E-mail"}</Badge>
            </div>
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-background/60 p-4">
              {messages.map((m) => (
                <div key={m.id} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed shadow-card",
                      m.direction === "out"
                        ? "rounded-br-md bg-primary text-white"
                        : "rounded-bl-md border border-border bg-surface"
                    )}
                  >
                    <p className="whitespace-pre-wrap">{m.content}</p>
                    <p
                      className={cn(
                        "mt-1 text-[10px]",
                        m.direction === "out" ? "text-white/70" : "text-faint-foreground"
                      )}
                    >
                      {formatDateTime(m.created_at)}
                      {m.classification && (
                        <span className="ml-1.5 rounded bg-black/10 px-1 py-px">
                          {CLASSIFICATION_LABEL[m.classification as keyof typeof CLASSIFICATION_LABEL] ??
                            m.classification}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-border p-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Escreva sua mensagem…"
                className="min-h-16"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="flex gap-1.5">
                  <Button variant="secondary" size="sm" onClick={handleSuggest} disabled={suggesting || !lastInbound}>
                    <Sparkles /> {suggesting ? "Pensando…" : "Sugerir resposta"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Simula uma resposta do lead para testar o fluxo (canal real ainda não conectado)"
                    onClick={async () => {
                      const text = prompt("Simular resposta do lead (teste do fluxo de classificação):");
                      if (text && active) {
                        await simulateInbound(active.id, text);
                        router.refresh();
                      }
                    }}
                  >
                    <TestTube2 /> Simular resposta
                  </Button>
                </div>
                <Button size="sm" onClick={handleSend} disabled={sending || !draft.trim()}>
                  <Send /> Enviar
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Painel do lead */}
      <div className="hidden border-l border-border lg:block">
        {lead && (
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-3">
              <ScoreBadge score={lead.lead_score} />
              <div>
                <p className="text-[13px] font-semibold">{lead.company_name}</p>
                <p className="text-xs text-muted-foreground">{lead.segment}</p>
              </div>
            </div>
            <div className="space-y-2 text-[13px]">
              <InfoRow label="Pipeline" value={data.stages.find((s) => s.id === lead.pipeline_stage_id)?.name ?? "—"} />
              <InfoRow label="Status" value={STATUS_LABEL[lead.status]} />
              <InfoRow
                label="Responsável"
                value={data.users.find((u) => u.id === lead.assigned_to)?.name ?? "—"}
              />
              <InfoRow label="Cidade" value={`${lead.city}, ${lead.country}`} />
              <InfoRow
                label="Valor potencial"
                value={lead.potential_value ? formatCurrency(lead.potential_value, currency) : "—"}
              />
            </div>
            <Button variant="secondary" size="sm" className="w-full" asChild>
              <Link href={`/leads/${lead.id}`}>Abrir perfil completo</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}
