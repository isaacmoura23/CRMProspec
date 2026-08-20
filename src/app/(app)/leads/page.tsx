import type { Metadata } from "next";
import Link from "next/link";
import { Compass, Target } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { LeadsFilters } from "@/features/leads/leads-filters";
import { LeadsTable, type LeadRow } from "@/features/leads/leads-table";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { ImportCsvDialog } from "@/features/leads/import-csv-dialog";
import { buildNextAction } from "@/features/leads/next-action";
import type { Lead } from "@/types";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

interface Params {
  q?: string;
  status?: string;
  nicho?: string;
  cidade?: string;
  site?: string;
  temperatura?: string;
  origem?: string;
  campanha?: string;
  resp?: string;
  ordenar?: string;
  dir?: string;
}

function applyFilters(leads: Lead[], p: Params): Lead[] {
  let out = leads.filter((l) => !l.archived);
  if (p.q) {
    const q = p.q.toLowerCase();
    out = out.filter((l) =>
      [l.company_name, l.contact_name, l.phone, l.whatsapp, l.email, l.instagram, l.city]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q))
    );
  }
  if (p.status) {
    const statuses = p.status.split(",");
    out = out.filter((l) => statuses.includes(l.status));
  }
  if (p.nicho) out = out.filter((l) => l.segment === p.nicho);
  if (p.cidade) out = out.filter((l) => l.city === p.cidade);
  if (p.site === "sem") out = out.filter((l) => !l.has_website);
  if (p.site === "com") out = out.filter((l) => l.has_website);
  if (p.site === "ruim")
    out = out.filter((l) => l.website_quality === "ruim" || l.website_quality === "desatualizado");
  if (p.temperatura) out = out.filter((l) => l.temperature === p.temperatura);
  if (p.origem) out = out.filter((l) => l.source === p.origem);
  if (p.campanha) out = out.filter((l) => l.campaign_id === p.campanha);
  if (p.resp === "__none__") out = out.filter((l) => !l.assigned_to);
  else if (p.resp) out = out.filter((l) => l.assigned_to === p.resp);
  return out;
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

  const filtered = applySort(applyFilters(db.leads, params), params);

  const rows: LeadRow[] = filtered.map((lead) => {
    const analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
    return {
      ...lead,
      problem: analysis?.main_problem ?? null,
      next_action: buildNextAction(lead, db.tasks, analysis),
    };
  });

  const allActive = db.leads.filter((l) => !l.archived);
  const segments = [...new Set(allActive.map((l) => l.segment))].sort();
  const cities = [...new Set(allActive.map((l) => l.city))].sort();

  const noLeadsAtAll = allActive.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Leads"
        description="Todas as oportunidades encontradas, enriquecidas e pontuadas."
      >
        <ImportCsvDialog />
        <NewLeadDialog />
        <Button asChild>
          <Link href="/prospectar">
            <Compass /> Prospectar
          </Link>
        </Button>
      </PageHeader>

      {noLeadsAtAll ? (
        <EmptyState
          icon={Target}
          title="Você ainda não possui leads"
          description="Encontre empresas automaticamente com a prospecção, adicione manualmente ou importe um CSV."
        >
          <Button asChild>
            <Link href="/prospectar">
              <Compass /> Encontrar leads
            </Link>
          </Button>
          <NewLeadDialog />
          <ImportCsvDialog />
        </EmptyState>
      ) : (
        <>
          <LeadsFilters segments={segments} cities={cities} users={db.users} campaigns={db.campaigns} />
          {rows.length === 0 ? (
            <EmptyState
              icon={Target}
              title="Nenhum lead com esses filtros"
              description="Ajuste ou limpe os filtros para ver mais resultados."
            />
          ) : (
            <LeadsTable leads={rows} users={db.users} campaigns={db.campaigns} />
          )}
        </>
      )}
    </div>
  );
}
