"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildDossierNow, savePresenceConfig } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatNumber, timeAgo } from "@/lib/format";
import type { PresenceConfig } from "@/agents/config";
import type { DossierSourceStatus } from "@/types/agents";
import type { DossierRow } from "@/services/presence/panel";

const DOT: Record<DossierSourceStatus, string> = { concluida: "bg-primary", parcial: "bg-warning", bloqueada: "bg-danger", pendente: "bg-border" };

export function PresenceConfigForm({ config, visual, canAdmin }: { config: PresenceConfig; visual: { available: boolean; reason: string | null }; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [perDay, setPerDay] = React.useState(String(config.dossiers_per_day));
  const [refreshDays, setRefreshDays] = React.useState(String(config.refresh_days));
  const [minScore, setMinScore] = React.useState(String(config.min_lead_score));
  const [delay, setDelay] = React.useState(String(config.fetch_delay_ms));
  const [onlyAgent, setOnlyAgent] = React.useState(config.only_agent_leads);
  const [visualOn, setVisualOn] = React.useState(config.visual);

  const field = (label: string, value: string, set: (v: string) => void, min: number, max: number, hint?: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => set(e.target.value)} disabled={!canAdmin} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  function save() {
    run(() =>
      savePresenceConfig({
        dossiers_per_day: Number(perDay),
        refresh_days: Number(refreshDays),
        min_lead_score: Number(minScore),
        only_agent_leads: onlyAgent,
        fetch_delay_ms: Number(delay),
        visual: visualOn,
      })
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração</CardTitle>
        <CardDescription>Só conteúdo público, sem login: se uma fonte barrar o acesso, ela aparece como “bloqueada” e a confiança do dossiê cai. Nada é contornado.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {field("Dossiês por dia", perDay, setPerDay, 0, 300, "Cada um faz algumas requisições a sites de terceiros.")}
          {field("Refazer a cada (dias)", refreshDays, setRefreshDays, 1, 180)}
          {field("Score mínimo do lead", minScore, setMinScore, 0, 100)}
          {field("Espera entre requisições (ms)", delay, setDelay, 0, 10_000, "Para não martelar os sites.")}
        </div>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={onlyAgent} onChange={(e) => setOnlyAgent(e.target.checked)} disabled={!canAdmin} />
            <span>
              <span className="block text-[13px] font-medium">Só leads criados pelos agentes</span>
              <span className="block text-xs text-muted-foreground">Desmarcar inclui os leads que você cadastrou à mão ou importou.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={visualOn} onChange={(e) => setVisualOn(e.target.checked)} disabled={!canAdmin} />
            <span>
              <span className="block text-[13px] font-medium">Avaliação visual do site (opcional)</span>
              <span className="block text-xs text-muted-foreground">
                Tira capturas do site no computador e as envia a um modelo com visão para notar legibilidade e aparência.{" "}
                {visual.available ? "Chrome/Edge e a chave da Anthropic foram encontrados." : `Indisponível agora: ${visual.reason}.`} As imagens saem do seu computador para a Anthropic.
              </span>
            </span>
          </label>
        </div>
        {canAdmin && (
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Salvar configuração
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RebuildButton({ leadId, canRun }: { leadId: string; canRun: boolean }) {
  const { run, pending } = useAgentAction();
  if (!canRun) return null;
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => buildDossierNow(leadId))}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refazer
    </Button>
  );
}

export function DossierList({ rows, waiting, doneToday, perDay, canRun }: { rows: DossierRow[]; waiting: number; doneToday: number; perDay: number; canRun: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dossiês</CardTitle>
        <CardDescription>
          {formatNumber(doneToday)} de {formatNumber(perDay)} montados hoje · {formatNumber(waiting)} lead(s) esperando. Abra o lead, na aba “Dossiê”, para ver cada afirmação com a evidência.
        </CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nenhum dossiê ainda. O agente começa pelos leads de maior score assim que estiver ligado e houver leads dos agentes.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(({ dossier: d, lead_name, segment, city }) => (
            <li key={d.id} className="space-y-1.5 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/leads/${d.lead_id}?tab=dossie`} className="text-[13px] font-medium hover:underline">
                  {lead_name}
                </Link>
                <span className="text-xs text-muted-foreground">{[segment, city].filter(Boolean).join(" · ")}</span>
                <Badge variant={d.confidence >= 80 ? "good" : d.confidence >= 50 ? "warning" : "danger"}>Confiança {d.confidence}</Badge>
                {d.website_quality_before !== d.website_quality_after && (
                  <Badge variant="info">
                    site: {d.website_quality_before} → {d.website_quality_after}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-muted-foreground">{timeAgo(d.updated_at)}</span>
                <RebuildButton leadId={d.lead_id} canRun={canRun} />
              </div>
              <ul className="flex flex-wrap gap-x-3 gap-y-0.5" aria-label="Estado das fontes">
                {d.sources.map((s) => (
                  <li key={s.key} className="flex items-center gap-1 text-xs text-muted-foreground" title={s.note ?? s.status}>
                    <span className={`size-2 rounded-full ${DOT[s.status]}`} aria-hidden />
                    {s.label}: {s.status}
                  </li>
                ))}
              </ul>
              {d.headline_problem && <p className="text-[13px]">Principal problema comprovado: {d.headline_problem}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
