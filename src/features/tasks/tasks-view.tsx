"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, List, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { deleteTask, toggleTask } from "@/actions/tasks";
import { formatTime } from "@/lib/format";
import type { Task, User } from "@/types";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<Task["type"], string> = {
  ligar: "Ligar",
  mensagem: "Mensagem",
  proposta: "Proposta",
  follow_up: "Follow-up",
  reuniao: "Reunião",
  demo: "Demo",
  outra: "Outra",
};

const PRIORITY_BADGE: Record<Task["priority"], "danger" | "warning" | "neutral"> = {
  alta: "danger",
  media: "warning",
  baixa: "neutral",
};

export interface TaskWithLead extends Task {
  lead_name: string | null;
}

function groupOf(task: Task): string {
  if (task.completed) return "concluidas";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const dayAfter = new Date(today.getTime() + 2 * 86_400_000);
  const week = new Date(today.getTime() + 7 * 86_400_000);
  const due = new Date(task.due_date);
  if (due < today) return "vencidas";
  if (due < tomorrow) return "hoje";
  if (due < dayAfter) return "amanha";
  if (due < week) return "semana";
  return "depois";
}

const GROUP_LABEL: Record<string, string> = {
  vencidas: "Vencidas",
  hoje: "Hoje",
  amanha: "Amanhã",
  semana: "Próximos 7 dias",
  depois: "Mais adiante",
  concluidas: "Concluídas",
};

export function TaskItem({ task, users }: { task: TaskWithLead; users: User[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const responsible = users.find((u) => u.id === task.assigned_to);
  const overdue = !task.completed && new Date(task.due_date) < new Date();

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-surface p-3.5 transition-colors hover:border-border-strong",
        task.completed && "opacity-60"
      )}
    >
      <Checkbox
        checked={task.completed}
        onCheckedChange={async () => {
          await toggleTask(task.id);
          router.refresh();
        }}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-[13px] font-medium", task.completed && "line-through")}>
            {task.title}
          </span>
          <Badge variant="neutral">{TYPE_LABEL[task.type]}</Badge>
          <Badge variant={PRIORITY_BADGE[task.priority]}>{task.priority}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <span className={cn(overdue && "font-medium text-danger")}>
            {new Date(task.due_date).toLocaleDateString("pt-BR")} às {formatTime(task.due_date)}
          </span>
          {responsible && ` · ${responsible.name.split(" ")[0]}`}
          {task.lead_name && task.lead_id && (
            <>
              {" · "}
              <Link href={`/leads/${task.lead_id}`} className="text-primary hover:underline">
                {task.lead_name}
              </Link>
            </>
          )}
        </p>
        {task.description && (
          <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>
        )}
      </div>
      <button
        onClick={async () => {
          if (confirm("Excluir esta tarefa?")) {
            await deleteTask(task.id);
            toast("Tarefa excluída.");
            router.refresh();
          }
        }}
        className="rounded p-1 text-faint-foreground hover:bg-danger-soft hover:text-danger cursor-pointer"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

export function TasksView({ tasks, users }: { tasks: TaskWithLead[]; users: User[] }) {
  const [month, setMonth] = React.useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const groups = ["vencidas", "hoje", "amanha", "semana", "depois", "concluidas"];
  const grouped = groups
    .map((g) => ({
      key: g,
      label: GROUP_LABEL[g]!,
      items: tasks
        .filter((t) => groupOf(t) === g)
        .sort((a, b) => a.due_date.localeCompare(b.due_date)),
    }))
    .filter((g) => g.items.length > 0);

  /* calendário mensal */
  const firstDay = new Date(month);
  const startWeekday = (firstDay.getDay() + 6) % 7; // segunda = 0
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = [
    ...Array.from({ length: startWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1)),
  ];
  const today = new Date();

  return (
    <Tabs defaultValue="lista">
      <TabsList>
        <TabsTrigger value="lista" className="gap-1.5">
          <List className="size-3.5" /> Lista
        </TabsTrigger>
        <TabsTrigger value="calendario" className="gap-1.5">
          <CalendarDays className="size-3.5" /> Calendário
        </TabsTrigger>
      </TabsList>

      <TabsContent value="lista" className="space-y-6">
        {grouped.map((g) => (
          <div key={g.key}>
            <h3
              className={cn(
                "mb-2 text-[13px] font-semibold",
                g.key === "vencidas" && "text-danger"
              )}
            >
              {g.label} <span className="font-normal text-faint-foreground">({g.items.length})</span>
            </h3>
            <div className="space-y-2">
              {g.items.map((t) => (
                <TaskItem key={t.id} task={t} users={users} />
              ))}
            </div>
          </div>
        ))}
      </TabsContent>

      <TabsContent value="calendario">
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold capitalize">
                {month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}
              </h3>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
              {["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((d) => (
                <div key={d} className="bg-surface-hover px-2 py-1.5 text-center text-[11px] font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
              {cells.map((date, i) => {
                if (!date) return <div key={`empty-${i}`} className="min-h-20 bg-surface" />;
                const dayTasks = tasks.filter((t) => {
                  const d = new Date(t.due_date);
                  return (
                    d.getFullYear() === date.getFullYear() &&
                    d.getMonth() === date.getMonth() &&
                    d.getDate() === date.getDate()
                  );
                });
                const isToday =
                  date.getDate() === today.getDate() &&
                  date.getMonth() === today.getMonth() &&
                  date.getFullYear() === today.getFullYear();
                return (
                  <div key={date.toISOString()} className="min-h-20 bg-surface p-1.5">
                    <span
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                        isToday ? "bg-primary font-semibold text-white" : "text-muted-foreground"
                      )}
                    >
                      {date.getDate()}
                    </span>
                    <div className="mt-0.5 space-y-0.5">
                      {dayTasks.slice(0, 3).map((t) => (
                        <Link
                          key={t.id}
                          href={t.lead_id ? `/leads/${t.lead_id}` : "/tarefas"}
                          className={cn(
                            "block truncate rounded px-1 py-0.5 text-[10px] leading-tight",
                            t.completed
                              ? "bg-surface-hover text-faint-foreground line-through"
                              : t.type === "reuniao"
                                ? "bg-score-hot-soft text-score-hot"
                                : t.type === "follow_up"
                                  ? "bg-warning-soft text-warning"
                                  : "bg-info-soft text-info"
                          )}
                          title={t.title}
                        >
                          {formatTime(t.due_date)} {t.title}
                        </Link>
                      ))}
                      {dayTasks.length > 3 && (
                        <span className="block px-1 text-[10px] text-faint-foreground">
                          +{dayTasks.length - 3} mais
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
