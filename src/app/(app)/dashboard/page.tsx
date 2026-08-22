import Link from "next/link";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Compass,
  Minus,
  Sparkles,
} from "lucide-react";
import { getDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import {
  bestOpportunities,
  computeAttention,
  computeFunnel,
  computeKpisWithTrend,
  type Period,
} from "@/services/stats";
import { formatCurrency, formatNumber, formatPercent, greeting, timeAgo } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "@/components/score-badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: "hoje", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "mes", label: "Este mês" },
  { key: "tudo", label: "Tudo" },
];

const TONE_DOT = {
  danger: "bg-danger",
  warning: "bg-warning",
  info: "bg-info",
  success: "bg-primary",
} as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string }>;
}) {
  const params = await searchParams;
  const period: Period = (PERIODS.find((p) => p.key === params.periodo)?.key ?? "30d") as Period;

  const db = getDb();
  const user = await getCurrentUser();
  const kpis = computeKpisWithTrend(db, period);
  const funnel = computeFunnel(db);
  const attention = computeAttention(db);
  const best = bestOpportunities(db, 5);
  const currency = db.organization.currency;

  const firstName = user.name.split(" ")[0];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}, {firstName}.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {attention.length > 0
              ? `Existem ${attention.reduce((a, i) => a + i.count, 0)} oportunidades que merecem sua atenção hoje.`
              : "Tudo em dia por aqui. Que tal encontrar novas oportunidades?"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild>
            <Link href="/prospectar">
              <Compass /> Prospectar
            </Link>
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/leads">Ver oportunidades</Link>
          </Button>
        </div>
      </div>

      {/* Filtro de período */}
      <div className="flex flex-wrap items-center gap-1">
        {PERIODS.map((p) => (
          <Link
            key={p.key}
            href={`/dashboard?periodo=${p.key}`}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
              period === p.key
                ? "bg-foreground text-white"
                : "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            )}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {kpis.map((kpi) => {
          const delta = kpi.value - kpi.previous;
          const pct =
            kpi.previous > 0 ? Math.round((delta / kpi.previous) * 100) : kpi.value > 0 ? 100 : 0;
          const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
          return (
            <Card key={kpi.key} className="transition-shadow hover:shadow-pop/50">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground">{kpi.label}</p>
                <p className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight">
                  {kpi.isCurrency ? formatCurrency(kpi.value, currency) : formatNumber(kpi.value)}
                </p>
                {period !== "tudo" && (
                  <p
                    className={cn(
                      "mt-1 flex items-center gap-0.5 text-[11px] font-medium",
                      delta > 0 ? "text-primary" : delta < 0 ? "text-danger" : "text-faint-foreground"
                    )}
                  >
                    <Icon className="size-3" />
                    {delta === 0 ? "estável" : `${pct > 0 ? "+" : ""}${pct}%`}
                    <span className="ml-1 font-normal text-faint-foreground">vs anterior</span>
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Funil comercial */}
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Funil comercial</CardTitle>
            <Link
              href="/pipeline"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Ver pipeline <ArrowRight className="size-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {funnel.map((stage, i) => {
              const max = funnel[0].count || 1;
              const width = Math.max(4, (stage.count / max) * 100);
              return (
                <div key={stage.key} className="group">
                  <div className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-[13px] text-muted-foreground">
                      {stage.label}
                    </span>
                    <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-surface-hover">
                      <div
                        className={cn(
                          "flex h-full items-center rounded-md px-2 transition-all",
                          i === funnel.length - 1 ? "bg-primary" : "bg-foreground/80"
                        )}
                        style={{ width: `${width}%` }}
                      >
                        <span className="text-xs font-semibold text-white tabular-nums">
                          {formatNumber(stage.count)}
                        </span>
                      </div>
                    </div>
                    <span className="w-14 shrink-0 text-right text-xs tabular-nums text-faint-foreground">
                      {stage.rate !== null ? formatPercent(stage.rate) : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Melhores oportunidades */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Melhores oportunidades</CardTitle>
            <Link
              href="/leads"
              className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Ver todas <ArrowRight className="size-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-1">
            {best.length === 0 && (
              <p className="py-6 text-center text-[13px] text-muted-foreground">
                Nenhuma oportunidade pontuada ainda.
              </p>
            )}
            {best.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
              >
                <ScoreBadge score={lead.lead_score} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {lead.company_name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {lead.segment} · {lead.city}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint-foreground" />
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* O que precisa da sua atenção */}
      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <CardTitle>O que precisa da sua atenção</CardTitle>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-muted-foreground">
              Nada pendente. Aproveite para prospectar novas empresas.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {attention.map((item, i) => (
                <Link
                  key={i}
                  href={item.href}
                  className="group flex items-start gap-3 rounded-lg border border-border p-3 transition-all hover:border-border-strong hover:shadow-card"
                >
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[item.tone])} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium group-hover:text-foreground">
                      {item.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-faint-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Atividade recente */}
      <Card>
        <CardHeader>
          <CardTitle>Atividade recente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          {[...db.activities]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, 6)
            .map((act) => {
              const lead = db.leads.find((l) => l.id === act.lead_id);
              const body = (
                <>
                  <span className="size-1.5 shrink-0 rounded-full bg-border-strong" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="font-medium">{lead?.company_name ?? "Sistema"}</span>
                    <span className="text-muted-foreground"> — {act.description}</span>
                  </span>
                  <span className="shrink-0 text-xs text-faint-foreground">
                    {timeAgo(act.created_at)}
                  </span>
                </>
              );
              const rowClass =
                "flex items-center gap-3 border-b border-border py-2.5 last:border-0 -mx-2 px-2 rounded-md";
              // Atividades de sistema não têm lead: linkar levava a /leads/null,
              // que cai em notFound().
              return lead ? (
                <Link
                  key={act.id}
                  href={`/leads/${lead.id}`}
                  className={`${rowClass} hover:bg-surface-hover/50`}
                >
                  {body}
                </Link>
              ) : (
                <div key={act.id} className={rowClass}>
                  {body}
                </div>
              );
            })}
        </CardContent>
      </Card>
    </div>
  );
}
