import type { Metadata } from "next";
import { Bot } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { AutomationsView } from "@/features/automations/automations-view";

export const metadata: Metadata = { title: "Automações" };
export const dynamic = "force-dynamic";

export default function AutomacoesPage() {
  const db = getDb();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automações"
        description="Motor Trigger → Condição → Ação. Cadências sempre pausam quando o lead responde."
      />
      {db.automation_rules.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="Nenhuma automação criada"
          description="Automatize movimentos repetitivos: priorizar leads quentes, pausar cadências ao receber resposta, criar tarefas após reuniões."
        />
      ) : null}
      <AutomationsView rules={db.automation_rules} />
    </div>
  );
}
