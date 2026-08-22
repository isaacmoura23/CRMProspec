import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
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
      {/* O estado vazio vive dentro do AutomationsView, que é quem tem o
          botão de criar — antes os dois apareciam juntos. */}
      <AutomationsView rules={db.automation_rules} />
    </div>
  );
}
