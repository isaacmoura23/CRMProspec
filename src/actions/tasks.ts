"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { logActivity } from "@/services/lead-service";
import type { Task, TaskPriority, TaskType } from "@/types";

const taskSchema = z.object({
  lead_id: z.string().nullable(),
  type: z.enum(["ligar", "mensagem", "proposta", "follow_up", "reuniao", "demo", "outra"]),
  title: z.string().min(3).max(160),
  description: z.string().max(600).optional(),
  due_date: z.string(),
  due_time: z.string().optional(),
  priority: z.enum(["baixa", "media", "alta"]),
  assigned_to: z.string().optional(),
});

export type TaskInput = z.infer<typeof taskSchema>;

export async function createTask(input: TaskInput): Promise<{ id: string } | { error: string }> {
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return { error: "Preencha título e data da tarefa." };
  const d = parsed.data;
  const db = getDb();
  const user = await getCurrentUser();

  const due = new Date(`${d.due_date}T${d.due_time || "09:00"}:00`);
  if (isNaN(due.getTime())) return { error: "Data inválida." };

  const task: Task = {
    id: uid("task"),
    organization_id: db.organization.id,
    lead_id: d.lead_id,
    assigned_to: d.assigned_to || user.id,
    type: d.type as TaskType,
    title: d.title,
    description: d.description || null,
    due_date: due.toISOString(),
    priority: d.priority as TaskPriority,
    completed: false,
    completed_at: null,
    created_at: nowIso(),
  };
  db.tasks.push(task);

  if (d.lead_id) {
    logActivity(d.lead_id, "tarefa_criada", `Tarefa criada: ${d.title}`, user.id);
    if (d.type === "follow_up") {
      const lead = db.leads.find((l) => l.id === d.lead_id);
      if (lead) lead.next_follow_up_at = task.due_date;
    }
  }
  saveDb();
  revalidatePath("/tarefas");
  revalidatePath("/follow-ups");
  if (d.lead_id) revalidatePath(`/leads/${d.lead_id}`);
  return { id: task.id };
}

export async function toggleTask(taskId: string): Promise<void> {
  const db = getDb();
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const user = await getCurrentUser();
  task.completed = !task.completed;
  task.completed_at = task.completed ? nowIso() : null;

  if (task.completed && task.lead_id) {
    if (task.type === "follow_up") {
      logActivity(task.lead_id, "follow_up", `Follow-up concluído: ${task.title}`, user.id);
      const lead = db.leads.find((l) => l.id === task.lead_id);
      if (lead) lead.next_follow_up_at = null;
    } else if (task.type === "reuniao") {
      logActivity(task.lead_id, "reuniao", `Reunião concluída: ${task.title}`, user.id);
    }
  }
  saveDb();
  revalidatePath("/tarefas");
  revalidatePath("/follow-ups");
  if (task.lead_id) revalidatePath(`/leads/${task.lead_id}`);
}

export async function deleteTask(taskId: string): Promise<void> {
  await getCurrentUser();
  const db = getDb();
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return;
  db.tasks = db.tasks.filter((t) => t.id !== taskId);

  // O agendamento vive em dois lugares: a tarefa e o `next_follow_up_at` do
  // lead. Apagar só a tarefa deixava o lead marcado com um follow-up que já
  // não existe, e ele nunca mais aparecia como "sem follow-up".
  if (task.type === "follow_up" && task.lead_id) {
    const lead = db.leads.find((l) => l.id === task.lead_id);
    const remaining = db.tasks
      .filter((t) => t.lead_id === task.lead_id && t.type === "follow_up" && !t.completed)
      .map((t) => t.due_date)
      .sort();
    if (lead) lead.next_follow_up_at = remaining[0] ?? null;
  }

  saveDb();
  revalidatePath("/tarefas");
  revalidatePath("/follow-ups");
  if (task.lead_id) revalidatePath(`/leads/${task.lead_id}`);
}
