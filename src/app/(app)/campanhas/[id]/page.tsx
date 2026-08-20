import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { LeadsTable, type LeadRow } from "@/features/leads/leads-table";
import { buildNextAction } from "@/features/leads/next-action";
import { campaignStats } from "@/services/campaign-stats";
import { formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Campanha" };
export const dynamic = "force-dynamic";

export default async function CampanhaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const campaign = db.campaigns.find((c) => c.id === id);
  if (!campaign) notFound();

  const stats = campaignStats(db, campaign);
  const rows: LeadRow[] = db.leads
    .filter((l) => !l.archived && l.campaign_id === id)
    .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0))
    .map((lead) => {
      const analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
      return {
        ...lead,
        problem: analysis?.main_problem ?? null,
        next_action: buildNextAction(lead, db.tasks, analysis),
      };
    });

  const metrics: Array<[string, string]> = [
    ["Leads adicionados", String(stats.total)],
    ["Contatados", String(stats.contacted)],
    ["Respostas", String(stats.replied)],
    ["Interessados", String(stats.interested)],
    ["Reuniões", String(stats.meetings)],
    ["Vendas", String(stats.won)],
    ["Taxa de resposta", formatPercent(stats.responseRate)],
    ["Conversão", formatPercent(stats.conversionRate)],
  ];

  return (
    <div className="space-y-5">
      <Link
        href="/campanhas"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Todas as campanhas
      </Link>
      <PageHeader title={campaign.name} description={campaign.description ?? undefined} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {metrics.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4 text-center">
              <p className="text-lg font-semibold tabular-nums">{value}</p>
              <p className="text-[11px] text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <LeadsTable leads={rows} users={db.users} campaigns={db.campaigns} />
    </div>
  );
}
