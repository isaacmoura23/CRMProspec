import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { AssistantChat } from "@/features/assistant/assistant-chat";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScoreBadge } from "@/components/score-badge";
import { timeAgo } from "@/lib/format";

export const metadata: Metadata = { title: "Análises IA" };
export const dynamic = "force-dynamic";

export default function AnalisesPage() {
  const db = getDb();
  const recent = [...db.lead_analysis]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 6);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Análises IA"
        description="Converse com o assistente comercial e acompanhe as últimas análises de oportunidade."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <AssistantChat />
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Últimas análises</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {recent.length === 0 && (
                <p className="py-3 text-[13px] text-muted-foreground">
                  Nenhuma análise ainda. Abra um lead e clique em “Analisar oportunidade”.
                </p>
              )}
              {recent.map((a) => {
                const lead = db.leads.find((l) => l.id === a.lead_id);
                if (!lead) return null;
                return (
                  <Link
                    key={a.id}
                    href={`/leads/${lead.id}`}
                    className="block rounded-lg border border-border p-3 transition-colors hover:border-border-strong"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{lead.company_name}</span>
                      <ScoreBadge score={lead.lead_score} size="sm" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.main_problem}</p>
                    <p className="mt-1 text-[11px] text-faint-foreground">
                      {timeAgo(a.created_at)} · confiança {a.confidence}%
                    </p>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
