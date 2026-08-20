import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Building2 } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, timeAgo } from "@/lib/format";

export const metadata: Metadata = { title: "Clientes" };
export const dynamic = "force-dynamic";

export default function ClientesPage() {
  const db = getDb();
  const clients = db.leads
    .filter((l) => !l.archived && l.status === "fechado")
    .sort((a, b) => (b.stage_entered_at ?? "").localeCompare(a.stage_entered_at ?? ""));

  const totalRevenue = clients.reduce((acc, c) => acc + (c.potential_value ?? 0), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clientes"
        description={
          clients.length > 0
            ? `${clients.length} negócios fechados · ${formatCurrency(totalRevenue, db.organization.currency)} em receita`
            : "Leads convertidos em clientes, com histórico completo preservado."
        }
      />

      {clients.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Nenhum cliente ainda"
          description="Quando um negócio for fechado no pipeline, o lead vira cliente automaticamente — sem perder o histórico."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clients.map((client) => {
            const proposal = db.proposals.find((p) => p.lead_id === client.id && p.status === "aceita");
            return (
              <Link key={client.id} href={`/leads/${client.id}`}>
                <Card className="h-full transition-all hover:border-border-strong hover:shadow-pop/50">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">{client.company_name}</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {client.segment} · {client.city}
                        </p>
                      </div>
                      <Badge variant="good">Cliente</Badge>
                    </div>
                    <div className="mt-3 space-y-1 text-[13px]">
                      {proposal && <p className="text-muted-foreground">{proposal.service}</p>}
                      <p className="font-semibold text-primary">
                        {client.potential_value
                          ? formatCurrency(client.potential_value, db.organization.currency)
                          : "Valor não informado"}
                      </p>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                      <span className="text-xs text-faint-foreground">
                        Fechado {timeAgo(client.stage_entered_at ?? client.updated_at)}
                      </span>
                      <span className="flex items-center gap-1 text-xs font-medium text-primary">
                        Histórico <ArrowRight className="size-3" />
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
