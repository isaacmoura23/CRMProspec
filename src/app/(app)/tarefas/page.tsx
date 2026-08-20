import type { Metadata } from "next";
import { CheckSquare } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TasksView, type TaskWithLead } from "@/features/tasks/tasks-view";
import { TaskDialog } from "@/features/tasks/task-dialog";

export const metadata: Metadata = { title: "Tarefas" };
export const dynamic = "force-dynamic";

export default async function TarefasPage({
  searchParams,
}: {
  searchParams: Promise<{ nova?: string }>;
}) {
  const params = await searchParams;
  const db = getDb();

  const tasks: TaskWithLead[] = db.tasks.map((t) => ({
    ...t,
    lead_name: db.leads.find((l) => l.id === t.lead_id)?.company_name ?? null,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tarefas"
        description="Ligações, mensagens, reuniões e follow-ups da operação comercial."
      >
        <TaskDialog leadId={null} users={db.users} defaultOpen={params.nova === "1"} />
      </PageHeader>

      {tasks.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="Nenhuma tarefa criada"
          description="Crie tarefas para organizar contatos, reuniões e follow-ups."
        >
          <TaskDialog leadId={null} users={db.users} />
        </EmptyState>
      ) : (
        <TasksView tasks={tasks} users={db.users} />
      )}
    </div>
  );
}
