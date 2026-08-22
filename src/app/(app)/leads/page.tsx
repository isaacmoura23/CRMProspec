import type { Metadata } from "next";
import Link from "next/link";
import { Compass, Target } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { LeadsTable, type LeadRow } from "@/features/leads/leads-table";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { ImportCsvDialog } from "@/features/leads/import-csv-dialog";
import { buildNextAction } from "@/features/leads/next-action";
import type { Lead } from "@/types";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

interface Params {
  ordenar?: string;
  dir?: string;
}

function applySort(leads: Lead[], p: Params): Lead[] {
  const dir = p.dir === "asc" ? 1 : -1;
  const key = p.ordenar ?? "score";
  return [...leads].sort((a, b) => {
    switch (key) {
      case "empresa":
        return a.company_name.localeCompare(b.company_name) * dir;
      case "contato":
        return ((a.last_contact_at ?? "").localeCompare(b.last_contact_at ?? "")) * dir;
      case "criado":
        return a.created_at.localeCompare(b.created_at) * dir;
      case "score":
      default:
        return ((a.lead_score ?? -1) - (b.lead_score ?? -1)) * dir;
    }
  });
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const db = getDb();

  // Todas as origens entram na lista: prospecção, cadastro manual e import
  // CSV. Filtrar por origem deixava a página permanentemente vazia mesmo
  // depois de criar um lead pelos botões que ficam nela mesma.
  const active = db.leads.filter((l) => !l.archived);
  const sorted = applySort(active, params);

  const rows: LeadRow[] = sorted.map((lead) => {
    const analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
    return {
      ...lead,
      problem: analysis?.main_problem ?? null,
      next_action: buildNextAction(lead, db.tasks, analysis),
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Leads"
        description="Suas oportunidades — prospectadas, importadas ou cadastradas — já enriquecidas e pontuadas."
      >
        <ImportCsvDialog />
        <NewLeadDialog />
        <Button asChild>
          <Link href="/prospectar">
            <Compass /> Prospectar
          </Link>
        </Button>
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState
          icon={Target}
          title="Nenhum lead ainda"
          description="Use a prospecção para encontrar empresas que combinam exatamente com os filtros que você escolher — ou cadastre e importe leads que você já tem."
        >
          <Button asChild>
            <Link href="/prospectar">
              <Compass /> Encontrar leads
            </Link>
          </Button>
        </EmptyState>
      ) : (
        <LeadsTable leads={rows} users={db.users} campaigns={db.campaigns} />
      )}
    </div>
  );
}
