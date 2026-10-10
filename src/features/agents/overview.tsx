import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Database, HardDrive, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ModeSelect } from "@/features/agents/controls";
import { kindLabel, MODE_BADGE, MODE_LABEL, TASK_STATUS_LABEL } from "@/features/agents/labels";
import { EventList } from "@/features/agents/task-list";
import { formatNumber, timeAgo } from "@/lib/format";
import type { AgentsOverview } from "@/services/agents/overview";

export function RunnerBanner({ data }: { data: AgentsOverview }) {
  const { runner, storage } = data;
  const persistence =
    storage === "supabase" ? (
      <span className="inline-flex items-center gap-1">
        <Database className="size-3.5" /> Salvando no Supabase
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        <HardDrive className="size-3.5" /> Salvando no arquivo local (.data/db.json)
      </span>
    );

  if (runner.alive) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <CheckCircle2 className="size-4" /> Runner ativo
        </span>
        <span className="text-muted-foreground">último batimento {timeAgo(runner.lastBeatAt)}</span>
        <span className="text-muted-foreground">{persistence}</span>
      </div>
    );
  }
  return (
    <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[13px]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {runner.lastBeatAt ? `O runner parou de responder (${timeAgo(runner.lastBeatAt)}).` : "O runner dos agentes não está rodando."}
        </p>
        <p className="text-muted-foreground">
          Ele sobe junto com o servidor: use <code className="rounded bg-surface px-1">npm run build &amp;&amp; npm start</code> (ou{" "}
          <code className="rounded bg-surface px-1">npm run dev</code>) no seu computador. Na Vercel ele não roda, e com{" "}
          <code className="rounded bg-surface px-1">AGENTS_RUNNER=off</code> fica desligado de propósito. Tarefas pedidas agora esperam na fila.
        </p>
        <p className="text-muted-foreground">{persistence}</p>
      </div>
    </div>
  );
}

export function FunnelStrip({ data }: { data: AgentsOverview }) {
  return (
    <ol className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Funil dos agentes">
      {data.funnel.map((step, i) => (
        <li key={step.key}>
          <Card className="h-full">
            <CardContent className="flex h-full flex-col gap-1 p-4">
              <span className="text-xs font-medium text-muted-foreground">
                {i + 1}. {step.label}
              </span>
              <span className="text-2xl font-semibold tabular-nums tracking-tight">{formatNumber(step.value)}</span>
              <span className="text-xs text-faint-foreground">{step.hint}</span>
            </CardContent>
          </Card>
        </li>
      ))}
    </ol>
  );
}

export function AgentCards({ data, canAdmin }: { data: AgentsOverview; canAdmin: boolean }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {data.agents.map((a) => (
        <Card key={a.id}>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                {a.name}
                <Badge variant={MODE_BADGE[a.mode]}>{MODE_LABEL[a.mode]}</Badge>
              </CardTitle>
              <CardDescription>{a.description}</CardDescription>
            </div>
            <Link
              href={a.id === "seller" ? "/agentes/vendedor" : `/agentes/${a.id}`}
              className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-primary hover:underline"
            >
              Abrir <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-4 gap-2 text-center">
              {[
                ["Na fila", a.pending],
                ["Rodando", a.running],
                ["Concluídas 24h", a.completedLast24h],
                ["Falhas 24h", a.failedLast24h],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg bg-surface-hover px-2 py-2">
                  <dt className="text-[11px] text-muted-foreground">{label}</dt>
                  <dd className={`text-lg font-semibold tabular-nums ${label === "Falhas 24h" && Number(value) > 0 ? "text-danger" : ""}`}>
                    {formatNumber(Number(value))}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wallet className="size-3.5" />
              {a.id === "presence"
                ? `Hoje: ${formatNumber(a.spent.dossiers)} dossiês montados`
                : a.id === "seller"
                ? `Hoje: ${formatNumber(a.spent.whatsapp_lookups)} consultas de número no WhatsApp`
                : `Hoje: ${formatNumber(a.spent.places_requests)} requisições ao Google${a.id === "prospector" ? ` · ${formatNumber(a.spent.leads)} leads` : ""}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {a.lastRun
                ? `Última tarefa: ${kindLabel(a.lastRun.kind)} — ${TASK_STATUS_LABEL[a.lastRun.status].toLowerCase()} ${timeAgo(a.lastRun.at)}${a.lastRun.error ? ` (${a.lastRun.error})` : ""}.`
                : "Nenhuma tarefa executada ainda."}
            </p>
            <ModeSelect agent={a.id} mode={a.mode} canEdit={canAdmin} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ApprovalsCallout({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Link
      href="/agentes/aprovacao"
      className="mb-4 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 text-[13px] hover:bg-primary-soft/70"
    >
      <ClipboardCheck className="size-4 text-primary-soft-fg" />
      <span className="font-medium text-primary-soft-fg">
        {count === 1 ? "1 pedido aguarda sua aprovação" : `${count} pedidos aguardam sua aprovação`}
      </span>
      <ArrowRight className="ml-auto size-4 text-primary-soft-fg" />
    </Link>
  );
}

export function RecentEvents({ data }: { data: AgentsOverview }) {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Atividade recente</CardTitle>
        <CardDescription>O que os agentes e o runner fizeram, do mais novo ao mais antigo.</CardDescription>
      </CardHeader>
      <EventList events={data.recentEvents} />
    </Card>
  );
}
