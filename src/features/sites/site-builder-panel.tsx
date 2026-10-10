"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildSiteNow, discardSitePreview, saveSiteBuilderConfig } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { SiteBuilderConfig } from "@/agents/config";
import type { SiteBuilderPanelData } from "@/services/sites/panel";
import type { SiteBuildStatus } from "@/types/agents";

const STATUS_LABEL: Record<SiteBuildStatus, string> = { na_fila: "Na fila", construindo: "Construindo", verificando: "Verificando", pronto: "Pronta", falhou: "Não entregue", cancelado: "Removida" };
const STATUS_BADGE: Record<SiteBuildStatus, "neutral" | "info" | "good" | "danger" | "outline"> = { na_fila: "neutral", construindo: "info", verificando: "info", pronto: "good", falhou: "danger", cancelado: "outline" };

export function SiteBuilderConfigForm({ config, browserFound, canAdmin }: { config: SiteBuilderConfig; browserFound: boolean; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [margin, setMargin] = React.useState(String(config.deadline_margin_hours));
  const [keep, setKeep] = React.useState(String(config.keep_days_after_meeting));
  const [needBrowser, setNeedBrowser] = React.useState(config.require_browser_check);

  const field = (label: string, value: string, set: (v: string) => void, min: number, max: number, hint?: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => set(e.target.value)} disabled={!canAdmin} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração</CardTitle>
        <CardDescription>A construção só começa com interesse explícito registrado e reunião marcada. Isto aqui ajusta o prazo e a verificação.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          {field("Pronta antes da reunião (h)", margin, setMargin, 1, 72, "Sem tempo hábil, o agente avisa em vez de entregar pela metade.")}
          {field("Dias no ar depois da reunião", keep, setKeep, 1, 60, "Depois disso o endereço da prévia deixa de abrir.")}
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={needBrowser} onChange={(e) => setNeedBrowser(e.target.checked)} disabled={!canAdmin} />
          <span>
            <span className="block text-[13px] font-medium">Exigir a verificação no navegador</span>
            <span className="block text-xs text-muted-foreground">
              Abre a página no Chrome/Edge (desktop e celular) para conferir erro de console, rolagem lateral e capturas de tela.{" "}
              {browserFound ? "Navegador encontrado." : "Nenhum navegador encontrado agora (instale o Chrome ou use CHROME_PATH): com a exigência ligada, nenhuma prévia é entregue."}
            </span>
          </span>
        </label>
        {canAdmin && (
          <Button onClick={() => run(() => saveSiteBuilderConfig({ deadline_margin_hours: Number(margin), keep_days_after_meeting: Number(keep), require_browser_check: needBrowser }))} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Salvar configuração
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function BuildItem({ row, canRun }: { row: SiteBuilderPanelData["rows"][number]; canRun: boolean }) {
  const { run, pending } = useAgentAction();
  const b = row.build;
  const [open, setOpen] = React.useState(false);
  return (
    <li className="space-y-1.5 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leads/${b.lead_id}?tab=dossie`} className="text-[13px] font-medium hover:underline">
          {row.lead_name}
        </Link>
        <Badge variant={STATUS_BADGE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
        {row.meeting_at && <span className="text-xs text-muted-foreground">reunião {formatDateTime(row.meeting_at)}</span>}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(b.updated_at)}</span>
      </div>
      {b.error && <p className="text-xs text-danger">{b.error}</p>}
      {b.status === "pronto" && (
        <p className="text-xs text-muted-foreground">
          Pronta {b.ready_at ? timeAgo(b.ready_at) : ""} · no ar até {formatDateTime(b.expires_at)} · {b.checks.filter((c) => c.ok).length}/{b.checks.length} verificações aprovadas
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {row.preview_path && (
          <a href={row.preview_path} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90">
            <ExternalLink className="size-3.5" /> Abrir a prévia
          </a>
        )}
        {b.checks.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Ocultar verificações" : "Ver verificações"}
          </Button>
        )}
        {canRun && (b.status === "pronto" || b.status === "falhou") && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => buildSiteNow(b.lead_id))}>
            {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refazer
          </Button>
        )}
        {canRun && b.status === "pronto" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => discardSitePreview(b.id))}>
            <Trash2 /> Tirar do ar
          </Button>
        )}
      </div>
      {open && (
        <ul className="space-y-0.5 rounded-lg bg-surface-hover px-3 py-2 text-[13px]">
          {b.checks.map((c) => (
            <li key={c.name} className={c.ok ? "" : "text-danger"}>
              <span className="font-medium">{c.ok ? "✓" : "✗"} {c.name}.</span> <span className="text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {b.status === "pronto" && b.screenshots.length > 0 && open && (
        <div className="flex flex-wrap gap-3">
          {b.screenshots.map((file) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={file} src={`/api/site-builds/${b.id}/${file.replace("screens/", "")}`} alt={`Captura ${file.includes("mobile") ? "no celular" : "no desktop"}`} className="max-h-72 rounded-lg border border-border" loading="lazy" />
          ))}
        </div>
      )}
    </li>
  );
}

export function SiteBuildList({ data, canRun }: { data: SiteBuilderPanelData; canRun: boolean }) {
  return (
    <div className="space-y-6">
      {data.waiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Reuniões esperando</CardTitle>
            <CardDescription>A porta ainda está fechada para estes leads. O agente não constrói nada sem interesse explícito registrado, dossiê válido e tempo hábil.</CardDescription>
          </CardHeader>
          <ul className="divide-y divide-border">
            {data.waiting.map((w) => (
              <li key={w.lead_id} className="px-5 py-3 text-[13px]">
                <Link href={`/leads/${w.lead_id}?tab=dossie`} className="font-medium hover:underline">
                  {w.lead_name}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">reunião {formatDateTime(w.meeting_at)}</span>
                <p className="text-xs text-muted-foreground">{w.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Prévias</CardTitle>
          <CardDescription>Só com o que o dossiê comprova, sem imagens nem textos inventados. Cada prévia vive num endereço não adivinhável e fora dos buscadores.</CardDescription>
        </CardHeader>
        {data.rows.length === 0 ? (
          <CardContent>
            <p className="text-[13px] text-muted-foreground">Nenhuma prévia ainda. Ela nasce sozinha quando um lead demonstra interesse e marca a reunião.</p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {data.rows.map((r) => (
              <BuildItem key={r.build.id} row={r} canRun={canRun} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
