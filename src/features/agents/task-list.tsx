"use client";

import { Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cancelTask } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { kindLabel, TASK_STATUS_BADGE, TASK_STATUS_LABEL } from "@/features/agents/labels";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { AgentEvent, AgentTask } from "@/types/agents";

/** Resumo de uma linha do que a execução produziu, conforme o tipo de tarefa. */
function resultSummary(task: AgentTask): string | null {
  const r = task.result as Record<string, number | string | boolean | undefined> | null;
  if (!r) return null;
  if (task.kind === "niche.analyze") {
    const parts = [`${r.analyzed ?? 0} nichos analisados`];
    if (r.skipped_by_cap) parts.push(`${r.skipped_by_cap} ficaram para amanhã (teto diário)`);
    if (r.failed) parts.push(`${r.failed} falharam`);
    if (r.live === false) parts.push("dados de demonstração");
    return parts.join(" · ");
  }
  if (task.kind === "prospect.run") {
    const parts = [`${r.found ?? 0} de ${r.requested ?? "?"} leads criados`];
    if (r.duplicates) parts.push(`${r.duplicates} duplicados`);
    if (r.filtered) parts.push(`${r.filtered} fora do perfil`);
    if (r.live === false) parts.push("dados de demonstração");
    return parts.join(" · ");
  }
  return null;
}

function payloadLabel(task: AgentTask): string | null {
  const p = task.payload as { niche_label?: string; niche?: string; city?: string };
  if (task.kind === "prospect.run" && p.city) return `${p.niche_label ?? p.niche} em ${p.city}`;
  return null;
}

export function TaskList({ tasks, canCancel }: { tasks: AgentTask[]; canCancel: boolean }) {
  const { run, pending } = useAgentAction();

  if (tasks.length === 0) {
    return <p className="px-5 pb-5 text-[13px] text-muted-foreground">Nenhuma tarefa ainda.</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => {
        const summary = resultSummary(t);
        const label = payloadLabel(t);
        const live = t.status === "pendente" || t.status === "processando";
        const pct = t.progress && t.progress.total > 0 ? (t.progress.done / t.progress.total) * 100 : 0;
        return (
          <li key={t.id} className="flex flex-col gap-1.5 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{kindLabel(t.kind)}</span>
              {label && <span className="text-[13px] text-muted-foreground">{label}</span>}
              <Badge variant={TASK_STATUS_BADGE[t.status]}>
                {t.status === "processando" && <Loader2 className="size-3 animate-spin" />}
                {TASK_STATUS_LABEL[t.status]}
              </Badge>
              {t.created_by ? <Badge variant="outline">Pedido manual</Badge> : null}
              <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(t.created_at)}>
                {timeAgo(t.finished_at ?? t.created_at)}
              </span>
              {canCancel && live && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => cancelTask(t.id))}
                  aria-label={`Cancelar ${kindLabel(t.kind)}`}
                >
                  <X /> Cancelar
                </Button>
              )}
            </div>
            {t.status === "processando" && t.progress && (
              <div className="space-y-1">
                <Progress value={pct} aria-label="Progresso da tarefa" />
                <p className="text-xs text-muted-foreground">
                  {t.progress.label} · {t.progress.done}/{t.progress.total}
                </p>
              </div>
            )}
            {/* Comparar com updated_at (e não com "agora") evita divergência entre servidor e navegador na hidratação. */}
            {t.status === "pendente" && Date.parse(t.next_run_at) - Date.parse(t.updated_at) > 60_000 && (
              <p className="text-xs text-muted-foreground">Agendada para {formatDateTime(t.next_run_at)}.</p>
            )}
            {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
            {t.last_error && t.status !== "concluido" && (
              <p className="text-xs text-danger">
                {t.last_error}
                {t.status === "pendente" ? ` (tentativa ${t.attempts}/${t.max_attempts})` : ""}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const LEVEL_DOT: Record<AgentEvent["level"], string> = {
  info: "bg-info",
  warn: "bg-warning",
  error: "bg-danger",
};

export function EventList({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <p className="px-5 pb-5 text-[13px] text-muted-foreground">Nenhum evento registrado ainda.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-2.5 px-5 py-2.5">
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${LEVEL_DOT[e.level]}`} aria-label={e.level} />
          <p className="min-w-0 flex-1 text-[13px]">{e.message}</p>
          <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(e.created_at)}>
            {timeAgo(e.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
