import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Megaphone } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { NewCampaignDialog } from "@/features/campaigns/new-campaign-dialog";
import { campaignStats } from "@/services/campaign-stats";
import { formatPercent, timeAgo } from "@/lib/format";

export const metadata: Metadata = { title: "Campanhas" };
export const dynamic = "force-dynamic";

export default function CampanhasPage() {
  const db = getDb();
  const campaigns = db.campaigns.filter((c) => !c.archived).map((c) => campaignStats(db, c));

  return (
    <div className="space-y-4">
      <PageHeader title="Campanhas" description="Agrupe leads por frente de prospecção e compare resultados.">
        <NewCampaignDialog />
      </PageHeader>

      {campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Nenhuma campanha ainda"
          description="Crie campanhas para agrupar leads por nicho, região ou período — e compare a conversão."
        >
          <NewCampaignDialog />
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {campaigns.map((s) => (
            <Link key={s.campaign.id} href={`/campanhas/${s.campaign.id}`}>
              <Card className="h-full transition-all hover:border-border-strong hover:shadow-pop/50">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">{s.campaign.name}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Criada {timeAgo(s.campaign.created_at)}
                        {s.campaign.description ? ` · ${s.campaign.description}` : ""}
                      </p>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-faint-foreground" />
                  </div>
                  <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                    <Metric label="Leads" value={String(s.total)} />
                    <Metric label="Contatados" value={String(s.contacted)} />
                    <Metric label="Respostas" value={String(s.replied)} />
                    <Metric label="Vendas" value={String(s.won)} />
                  </div>
                  <div className="mt-3 flex justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                    <span>
                      Taxa de resposta:{" "}
                      <span className="font-semibold text-foreground">{formatPercent(s.responseRate)}</span>
                    </span>
                    <span>
                      Conversão:{" "}
                      <span className="font-semibold text-primary">{formatPercent(s.conversionRate)}</span>
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-hover px-2 py-2">
      <p className="text-base font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
