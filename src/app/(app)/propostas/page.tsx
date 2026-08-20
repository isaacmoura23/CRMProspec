import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { ProposalsView } from "@/features/proposals/proposals-view";

export const metadata: Metadata = { title: "Propostas" };
export const dynamic = "force-dynamic";

export default function PropostasPage() {
  const db = getDb();
  const proposals = [...db.proposals].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Propostas"
        description="Rascunho → Enviada → Visualizada → Aceita. Proposta aceita converte o lead em cliente."
      />
      <ProposalsView proposals={proposals} leads={db.leads} currency={db.organization.currency} />
    </div>
  );
}
