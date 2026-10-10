"use client";

import * as React from "react";
import { Loader2, ShieldBan, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { blockNumber, saveSellerConfig, unblockNumber } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime } from "@/lib/format";
import type { SellerConfig } from "@/agents/config";
import type { ChannelBlock } from "@/types/agents";

const WEEKDAYS: Array<[number, string]> = [
  [1, "Seg"],
  [2, "Ter"],
  [3, "Qua"],
  [4, "Qui"],
  [5, "Sex"],
  [6, "Sáb"],
  [7, "Dom"],
];

export function SellerConfigForm({ config, canAdmin }: { config: SellerConfig; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [days, setDays] = React.useState<number[]>(config.send_days);
  const [start, setStart] = React.useState(String(config.start_hour));
  const [end, setEnd] = React.useState(String(config.end_hour));
  const [cap, setCap] = React.useState(String(config.daily_cap_max));
  const [warmup, setWarmup] = React.useState(config.warmup);
  const [minGap, setMinGap] = React.useState(String(config.min_gap_seconds));
  const [maxGap, setMaxGap] = React.useState(String(config.max_gap_seconds));
  const [spacing1, setSpacing1] = React.useState(String(config.touch_spacing_days[0] ?? 3));
  const [spacing2, setSpacing2] = React.useState(String(config.touch_spacing_days[1] ?? config.touch_spacing_days[0] ?? 4));
  const [maxTouches, setMaxTouches] = React.useState(String(config.max_touches));
  const [minScore, setMinScore] = React.useState(String(config.min_lead_score));
  const [lookups, setLookups] = React.useState(String(config.lookups_per_day));
  const [pendingCap, setPendingCap] = React.useState(String(config.max_pending_approvals));
  const [onlyAgent, setOnlyAgent] = React.useState(config.only_agent_leads);

  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));

  function save() {
    run(() =>
      saveSellerConfig({
        send_days: days,
        start_hour: Number(start),
        end_hour: Number(end),
        daily_cap_max: Number(cap),
        warmup,
        min_gap_seconds: Number(minGap),
        max_gap_seconds: Number(maxGap),
        touch_spacing_days: [Number(spacing1), Number(spacing2)],
        max_touches: Number(maxTouches),
        min_lead_score: Number(minScore),
        lookups_per_day: Number(lookups),
        max_pending_approvals: Number(pendingCap),
        only_agent_leads: onlyAgent,
      })
    );
  }

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
        <CardTitle>Política de envio</CardTitle>
        <CardDescription>
          Limita o volume e o ritmo ao que uma pessoa faria. Abordar quem não é seu contato por um número não oficial tem risco real de banimento: quanto mais
          conservadora a política, menor o risco.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2" disabled={!canAdmin}>
          <legend className="text-sm font-medium">Dias e horário de envio (horário de São Paulo)</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map(([d, label]) => (
              <label
                key={d}
                className={`cursor-pointer rounded-lg border px-3 py-1 text-[13px] ${days.includes(d) ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-muted-foreground"}`}
              >
                <input type="checkbox" className="sr-only" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                {label}
              </label>
            ))}
          </div>
          <div className="grid max-w-sm grid-cols-2 gap-3">
            {field("Das (hora)", start, setStart, 0, 23)}
            {field("Até (hora)", end, setEnd, 1, 24)}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {field("Máximo por dia", cap, setCap, 0, 200, "Com o aquecimento ligado, o teto começa em 10 e sobe por semana até este valor.")}
          {field("Espera mínima (s)", minGap, setMinGap, 10, 3600, "Entre dois envios, sorteada entre o mínimo e o máximo.")}
          {field("Espera máxima (s)", maxGap, setMaxGap, 10, 7200)}
          {field("Score mínimo do lead", minScore, setMinScore, 0, 100)}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {field("Toques por lead", maxTouches, setMaxTouches, 1, 3, "No máximo 3: primeira abordagem e até 2 acompanhamentos.")}
          {field("Dias até o 2º toque", spacing1, setSpacing1, 1, 30)}
          {field("Dias até o 3º toque", spacing2, setSpacing2, 1, 30)}
          {field("Consultas de número por dia", lookups, setLookups, 0, 500)}
          {field("Pedidos esperando aprovação", pendingCap, setPendingCap, 1, 50, "O agente para de preparar mensagens quando há pedidos demais.")}
        </div>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={warmup} onChange={(e) => setWarmup(e.target.checked)} disabled={!canAdmin} />
            <span>
              <span className="block text-[13px] font-medium">Aquecer o número</span>
              <span className="block text-xs text-muted-foreground">Recomendado. Um número novo que passa a mandar dezenas de mensagens por dia é o padrão que mais leva a restrição.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={onlyAgent} onChange={(e) => setOnlyAgent(e.target.checked)} disabled={!canAdmin} />
            <span>
              <span className="block text-[13px] font-medium">Abordar só leads criados pelos agentes</span>
              <span className="block text-xs text-muted-foreground">Desmarcar libera também os leads que você cadastrou à mão ou importou.</span>
            </span>
          </label>
        </div>

        {canAdmin && (
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Salvar política de envio
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

const SOURCE_LABEL: Record<ChannelBlock["source"], string> = { manual: "Manual", opt_out: "Pediu para parar", invalid: "Sem WhatsApp" };

export function BlocklistManager({ rows, canAdmin }: { rows: ChannelBlock[]; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [phone, setPhone] = React.useState("");
  const [reason, setReason] = React.useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lista de bloqueio</CardTitle>
        <CardDescription>
          Números que nunca recebem mensagem: quem pediu para parar, números sem WhatsApp e o que você bloquear. Vale também para mensagens já aprovadas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canAdmin && (
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="block-phone">Telefone</Label>
              <Input id="block-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(41) 99999-8888" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-reason">Motivo (opcional)</Label>
              <Input id="block-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pediu para não ser contatado" />
            </div>
            <Button
              variant="secondary"
              disabled={pending || phone.trim().length < 8}
              onClick={() => {
                run(() => blockNumber({ phone, reason }));
                setPhone("");
                setReason("");
              }}
            >
              <ShieldBan /> Bloquear
            </Button>
          </div>
        )}
        {rows.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nenhum número bloqueado.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                <span className="font-medium tabular-nums">{canAdmin ? b.phone : `••••${b.id.slice(-4)}`}</span>
                <Badge variant="outline">{SOURCE_LABEL[b.source]}</Badge>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{b.reason}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(b.created_at)}</span>
                {canAdmin && (
                  <Button size="xs" variant="danger-ghost" disabled={pending} onClick={() => run(() => unblockNumber(b.phone))} aria-label={`Liberar ${b.phone}`}>
                    <Trash2 /> Liberar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
