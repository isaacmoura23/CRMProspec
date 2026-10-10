"use client";

import * as React from "react";
import { Loader2, Pause, Play, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activateAdCampaign, approveAdCampaign, endAdCampaign, pauseAdCampaign, proposeCampaignNow, recordAdReport, rejectAdCampaign, saveTrafficConfig, setAdCampaignBudget } from "@/actions/growth";
import { useAgentAction } from "@/features/agents/controls";
import { formatBrl } from "@/lib/money";
import { formatNumber, timeAgo } from "@/lib/format";

/** Data sem hora (AAAA-MM-DD) em dd/mm/aaaa — sem passar por Date, que a deslocaria um dia pelo fuso. */
const day = (s: string) => s.split("-").reverse().join("/");
import type { TrafficConfig } from "@/agents/config";
import type { CampaignRow, TrafficPanelData } from "@/services/growth/panel";
import type { AdCampaignStatus } from "@/types/agents";

const STATUS_LABEL: Record<AdCampaignStatus, string> = {
  rascunho: "Rascunho",
  pendente: "Rascunho esperando você",
  aprovado: "Aprovada (ainda não gasta)",
  ativa: "Ativa",
  pausada: "Pausada",
  encerrada: "Encerrada",
  recusada: "Recusada",
  expirada: "Expirou",
  falhou: "Falhou",
};
const STATUS_BADGE: Record<AdCampaignStatus, "warning" | "info" | "good" | "danger" | "outline" | "neutral"> = {
  rascunho: "neutral",
  pendente: "warning",
  aprovado: "info",
  ativa: "good",
  pausada: "outline",
  encerrada: "outline",
  recusada: "outline",
  expirada: "outline",
  falhou: "danger",
};

function Meter({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">
        {formatBrl(spent)} <span className="text-sm font-normal text-muted-foreground">de {formatBrl(cap)}</span>
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full ${pct >= 100 ? "bg-danger" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SpendSummaryCard({ summary }: { summary: TrafficPanelData["summary"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gasto e tetos</CardTitle>
        <CardDescription>Os tetos valem no servidor: nenhuma campanha é ativada, nem orçamento aumentado, se o gasto diário ou mensal previsto passar deles.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-3">
        <Meter label="Orçamento diário das campanhas ativas" spent={summary.activeDailyCents} cap={summary.caps.daily_cap_cents} />
        <Meter label="Gasto de hoje (relatórios)" spent={summary.todaySpentCents} cap={summary.caps.daily_cap_cents} />
        <Meter label="Gasto do mês (relatórios)" spent={summary.monthSpentCents} cap={summary.caps.monthly_cap_cents} />
      </CardContent>
    </Card>
  );
}

function CampaignItem({ row, canDecide }: { row: CampaignRow; canDecide: boolean }) {
  const { run, pending } = useAgentAction();
  const c = row.campaign;
  const [budget, setBudget] = React.useState((c.daily_budget_cents / 100).toFixed(2));
  const [externalId, setExternalId] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const changed = Math.round(Number(budget.replace(",", ".")) * 100) !== c.daily_budget_cents;

  return (
    <li className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{c.name}</span>
        <Badge variant={STATUS_BADGE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
        <span className="text-xs text-muted-foreground">
          {formatBrl(c.daily_budget_cents)} por dia · de {day(c.start_date)}
          {c.end_date ? ` a ${day(c.end_date)}` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(c.created_at)}</span>
      </div>
      <div className="rounded-lg bg-surface-hover px-3 py-2 text-[13px]">
        <p className="font-medium">{c.headline}</p>
        <p className="text-muted-foreground">{c.body}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Botão: “{c.cta}” · Público: {c.audience || "—"}
        </p>
      </div>
      {(c.status === "ativa" || c.status === "pausada" || c.status === "encerrada") && (
        <p className="text-xs text-muted-foreground">
          Últimos 7 dias: {formatBrl(row.last7.spend_cents)} gastos · {formatNumber(row.last7.impressions)} impressões · {formatNumber(row.last7.clicks)} cliques · {formatNumber(row.last7.conversions)} conversões
        </p>
      )}
      {c.error && <p className="text-xs text-danger">{c.error}</p>}

      {canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          {c.status === "pendente" && (
            <>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => rejectAdCampaign(c.id))}>
                <X /> Recusar
              </Button>
              <Button size="sm" disabled={pending} onClick={() => run(() => approveAdCampaign(c.id))}>
                Aprovar o rascunho
              </Button>
              <span className="text-xs text-muted-foreground">Aprovar não gasta nada: ativar é outro clique.</span>
            </>
          )}
          {(c.status === "aprovado" || c.status === "pausada") && (
            <>
              <Input className="h-8 w-44" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="ID na plataforma (opcional)" aria-label="ID da campanha na plataforma" />
              <Button size="sm" disabled={pending} onClick={() => run(() => activateAdCampaign(c.id, externalId))}>
                {pending ? <Loader2 className="animate-spin" /> : <Play />} Ativar (começa a gastar)
              </Button>
            </>
          )}
          {c.status === "ativa" && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => pauseAdCampaign(c.id))}>
              <Pause /> Pausar
            </Button>
          )}
          {(c.status === "aprovado" || c.status === "ativa" || c.status === "pausada") && (
            <>
              <Input className="h-8 w-28" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Orçamento diário em reais" />
              {changed && (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setAdCampaignBudget(c.id, Math.round(Number(budget.replace(",", ".")) * 100)))}>
                  Ajustar orçamento
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => endAdCampaign(c.id))}>
                Encerrar
              </Button>
            </>
          )}
          {(c.status === "ativa" || c.status === "pausada" || c.status === "encerrada") && (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
              {open ? "Fechar relatório" : "Lançar o relatório do dia"}
            </Button>
          )}
        </div>
      )}
      {open && canDecide && <ReportForm campaignId={c.id} />}
    </li>
  );
}

function ReportForm({ campaignId }: { campaignId: string }) {
  const { run, pending } = useAgentAction();
  const [day, setDay] = React.useState(new Date().toISOString().slice(0, 10));
  const [imp, setImp] = React.useState("0");
  const [clk, setClk] = React.useState("0");
  const [spend, setSpend] = React.useState("0,00");
  const [conv, setConv] = React.useState("0");
  const field = (label: string, value: string, set: (v: string) => void, type = "text") => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input className="h-8" type={type} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-6">
      {field("Dia", day, setDay, "date")}
      {field("Impressões", imp, setImp, "number")}
      {field("Cliques", clk, setClk, "number")}
      {field("Gasto (R$)", spend, setSpend)}
      {field("Conversões", conv, setConv, "number")}
      <div className="flex items-end">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(() => recordAdReport({ campaign_id: campaignId, day, impressions: Number(imp), clicks: Number(clk), spend_cents: Math.round(Number(spend.replace(",", ".")) * 100), conversions: Number(conv) }))
          }
        >
          Gravar
        </Button>
      </div>
    </div>
  );
}

export function CampaignList({ rows, canDecide, canRun }: { rows: CampaignRow[]; canDecide: boolean; canRun: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Campanhas</CardTitle>
          <CardDescription>Toda campanha nasce rascunho. Aprovar o rascunho não gasta nada; ativar é um segundo clique, dentro dos tetos. Sem plataforma ligada, você cria a campanha lá e o CRM guarda o controle, os tetos e os relatórios.</CardDescription>
        </div>
        {canRun && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => proposeCampaignNow())}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Propor agora
          </Button>
        )}
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nenhuma campanha ainda. O agente propõe um rascunho por semana quando o perfil da empresa tem serviços.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <CampaignItem key={r.campaign.id} row={r} canDecide={canDecide} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TrafficConfigForm({ config, canAdmin }: { config: TrafficConfig; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [daily, setDaily] = React.useState((config.daily_cap_cents / 100).toFixed(2));
  const [monthly, setMonthly] = React.useState((config.monthly_cap_cents / 100).toFixed(2));
  const [max, setMax] = React.useState(String(config.max_pending_campaigns));
  const cents = (v: string) => Math.round(Number(v.replace(",", ".")) * 100);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tetos de gasto</CardTitle>
        <CardDescription>O teto mensal nunca fica abaixo do diário. Zerar o teto diário impede qualquer ativação.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Teto por dia (R$)</Label>
            <Input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} disabled={!canAdmin} />
          </div>
          <div className="space-y-1.5">
            <Label>Teto por mês (R$)</Label>
            <Input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} disabled={!canAdmin} />
          </div>
          <div className="space-y-1.5">
            <Label>Rascunhos esperando</Label>
            <Input type="number" min={1} max={20} value={max} onChange={(e) => setMax(e.target.value)} disabled={!canAdmin} />
          </div>
        </div>
        {canAdmin && (
          <Button disabled={pending} onClick={() => run(() => saveTrafficConfig({ daily_cap_cents: cents(daily), monthly_cap_cents: cents(monthly), max_pending_campaigns: Number(max) }))}>
            {pending && <Loader2 className="animate-spin" />} Salvar tetos
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
