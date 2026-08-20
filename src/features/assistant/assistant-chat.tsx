"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScoreBadge } from "@/components/score-badge";
import { askAssistant, type AssistantReply } from "@/actions/assistant";
import { cn } from "@/lib/utils";

interface ChatItem {
  role: "user" | "assistant";
  text: string;
  leads?: AssistantReply["leads"];
}

const SUGGESTIONS = [
  "Quais leads devo abordar hoje?",
  "Mostre leads com score acima de 80",
  "Quais prospects disseram que não era prioridade?",
  "Quais leads estão sem follow-up há mais de 5 dias?",
  "Quais campanhas estão convertendo melhor?",
];

export function AssistantChat() {
  const [items, setItems] = React.useState<ChatItem[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items, loading]);

  async function ask(question: string) {
    if (!question.trim() || loading) return;
    setItems((prev) => [...prev, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    try {
      const reply = await askAssistant(question);
      setItems((prev) => [...prev, { role: "assistant", text: reply.answer, leads: reply.leads }]);
    } catch {
      setItems((prev) => [
        ...prev,
        { role: "assistant", text: "Não consegui consultar os dados agora. Tente novamente." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-3xl flex-col rounded-xl border border-border bg-surface shadow-card">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary-soft">
              <Sparkles className="size-5 text-primary" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Assistente comercial</h3>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
                Pergunte em linguagem natural — as respostas vêm dos dados reais do seu CRM,
                nunca de suposições.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item, i) => (
          <div key={i} className={cn("flex", item.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed",
                item.role === "user"
                  ? "rounded-br-md bg-foreground text-white"
                  : "rounded-bl-md border border-border bg-surface-hover/60"
              )}
            >
              <p className="whitespace-pre-wrap">{item.text}</p>
              {item.leads && item.leads.length > 0 && (
                <div className="mt-2.5 space-y-1">
                  {item.leads.map((l) => (
                    <Link
                      key={l.id}
                      href={`/leads/${l.id}`}
                      className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors hover:border-primary/50"
                    >
                      <ScoreBadge score={l.score} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{l.company}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {l.segment} · {l.city} · {l.detail}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Consultando os dados do CRM…
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-border p-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(input)}
          placeholder="Pergunte algo sobre seus leads, campanhas ou follow-ups…"
        />
        <Button onClick={() => ask(input)} disabled={loading || !input.trim()}>
          <Send />
        </Button>
      </div>
    </div>
  );
}
