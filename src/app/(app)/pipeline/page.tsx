import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { PipelineKanban, type KanbanLead } from "@/features/pipeline/kanban";
import { buildNextAction } from "@/features/leads/next-action";
import { formatCurrency } from "@/lib/format";

export const metadata: Metadata = { title: "Pipeline" };
export const dynamic = "force-dynamic";

export default function PipelinePage() {
  const db = getDb();
  const leads: KanbanLead[] = db.leads
    .filter((l) => !l.archived)
    .map((lead) => ({
      ...lead,
      next_action: buildNextAction(
        lead,
        db.tasks,
        db.lead_analysis.find((a) => a.lead_id === lead.id)
      ),
    }));

  const openValue = leads
    .filter((l) => l.status !== "fechado" && l.status !== "perdido")
    .reduce((acc, l) => acc + (l.potential_value ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description={`${leads.filter((l) => l.status !== "fechado" && l.status !== "perdido").length} negociações em aberto · ${formatCurrency(openValue, db.organization.currency)} em potencial`}
      />
      <PipelineKanban
        stages={db.pipeline_stages}
        leads={leads}
        users={db.users}
        currency={db.organization.currency}
      />
    </div>
  );
}
