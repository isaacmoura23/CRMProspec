"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Copy, Loader2, MessageSquareQuote, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScoreBadge } from "@/components/score-badge";
import { useToast } from "@/components/ui/toast";
import { toggleTask } from "@/actions/tasks";
import { generateOutreach } from "@/actions/ai";
import { CLASSIFICATION_LABEL } from "@/ai/schemas";
import { formatDate, formatTime, timeAgo } from "@/lib/format";
import type { Task } from "@/types";
import { cn } from "@/lib/utils";

export interface FollowUpItem extends Task {
  lead_name: string;
  lead_score: number | null;
  last_inbound: string | null;
  last_inbound_at: string | null;
  last_classification: string | null;
}

function groupOf(t: Task): string {
  if (t.completed) return "concluido";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const dayAfter = new Date(today.getTime() + 2 * 86_400_000);
  const week = new Date(today.getTime() + 7 * 86_400_000);
  const due = new Date(t.due_date);
  if (due < today) return "vencido";
  if (due < tomorrow) return "hoje";
  if (due < dayAfter) return "amanha";
  if (due < week) return "semana";
  return "depois";
}

const GROUPS: Array<[string, string]> = [
  ["vencido", "Vencidos"],
  ["hoje", "Hoje"],
  ["amanha", "Amanhã"],
  ["semana", "Próximos 7 dias"],
  ["depois", "Mais adiante"],
  ["concluido", "Concluídos"],
];

function FollowUpCard({ item }: { item: FollowUpItem }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const overdue = !item.completed && new Date(item.due_date) < new Date();

  async function suggest() {
    setLoading(true);
    try {
      const res = await generateOutreach(item.lead_id!, "follow_up", "padrao", Math.floor(Math.random() * 3));
      if ("error" in res) {
        toast(res.error, "error");
        return;
      }
      setSuggestion(res.generation.content);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface transition-colors hover:border-border-strong">
      <div className="flex items-center gap-3 p-3.5">
        <Checkbox
          checked={item.completed}
          onCheckedChange={async () => {
            await toggleTask(item.id);
            toast(item.completed ? "Follow-up reaberto." : "Follow-up concluído.");
            router.refresh();
          }}
        />
        <ScoreBadge score={item.lead_score} size="sm" />
        <div className="min-w-0 flex-1">
          <Link href={`/leads/${item.lead_id}`} className="text-[13px] font-medium hover:text-primary">
            {item.lead_name}
          </Link>
          <p className="text-xs text-muted-foreground">
            <span className={cn(overdue && "font-medium text-danger")}>
              {formatDate(item.due_date)} às {formatTime(item.due_date)}
            </span>
            {" · "}
            {item.title}
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-surface-hover cursor-pointer"
        >
          Contexto <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3.5">
          {item.last_inbound ? (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-faint-foreground">
                <MessageSquareQuote className="size-3.5" /> Última interação
                {item.last_inbound_at && ` · ${timeAgo(item.last_inbound_at)}`}
              </p>
              <blockquote className="rounded-lg bg-surface-hover px-3 py-2 text-[13px] italic text-muted-foreground">
                “{item.last_inbound}”
              </blockquote>
              {item.last_classification && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Contexto:{" "}
                  <Badge variant="warning">
                    {CLASSIFICATION_LABEL[item.last_classification as keyof typeof CLASSIFICATION_LABEL] ??
                      item.last_classification}
                  </Badge>
                </p>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Sem resposta registrada — este follow-up retoma um contato sem retorno.
            </p>
          )}

          {suggestion ? (
            <div className="rounded-lg border border-primary/30 bg-primary-soft/30 p-3.5">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary-soft-fg">
                <Sparkles className="size-3.5" /> Sugestão da IA
              </p>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{suggestion}</p>
              <div className="mt-2 flex gap-1.5">
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={async () => {
                    await navigator.clipboard.writeText(suggestion);
                    toast("Sugestão copiada.");
                  }}
                >
                  <Copy /> Copiar
                </Button>
                <Button variant="ghost" size="xs" onClick={suggest} disabled={loading}>
                  {loading ? <Loader2 className="animate-spin" /> : <Sparkles />} Gerar outra
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="soft" onClick={suggest} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Gerar follow-up com IA
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function FollowUpsView({ items }: { items: FollowUpItem[] }) {
  const grouped = GROUPS.map(([key, label]) => ({
    key,
    label,
    items: items.filter((i) => groupOf(i) === key).sort((a, b) => a.due_date.localeCompare(b.due_date)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6">
      {grouped.map((g) => (
        <div key={g.key}>
          <h3 className={cn("mb-2 text-[13px] font-semibold", g.key === "vencido" && "text-danger")}>
            {g.label} <span className="font-normal text-faint-foreground">({g.items.length})</span>
          </h3>
          <div className="space-y-2">
            {g.items.map((i) => (
              <FollowUpCard key={i.id} item={i} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
