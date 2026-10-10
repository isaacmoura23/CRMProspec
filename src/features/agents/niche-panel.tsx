"use client";

import * as React from "react";
import { Ban, Loader2, Pin, PinOff, Play, Radar, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runNicheAnalysisNow, saveNicheAnalystConfig, setNicheTargetStatus } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { NicheAnalystConfig } from "@/agents/config";
import type { NicheTarget } from "@/types/agents";

function citiesToText(cities: NicheAnalystConfig["cities"]): string {
  return cities.map((c) => [c.city, c.state].filter(Boolean).join(", ")).join("\n");
}

/** Uma cidade por linha: "Curitiba, PR". País fica em Brasil, como no formulário de Prospectar. */
function textToCities(text: string): NicheAnalystConfig["cities"] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [city, state] = line.split(",").map((s) => s.trim());
      return { city: city ?? "", state: state || undefined, country: "Brasil" };
    });
}

const scoreVariant = (s: number) => (s >= 70 ? "hot" : s >= 50 ? "good" : s >= 30 ? "mid" : "cold");

export function NichePanel({
  config,
  niches,
  targets,
  canAdmin,
  canRun,
  runnerAlive,
}: {
  config: NicheAnalystConfig;
  niches: Array<{ key: string; label: string }>;
  targets: NicheTarget[];
  canAdmin: boolean;
  canRun: boolean;
  runnerAlive: boolean;
}) {
  const { run, pending } = useAgentAction();
  const [cities, setCities] = React.useState(citiesToText(config.cities));
  const [selected, setSelected] = React.useState<Set<string>>(new Set(config.niches));
  const [sample, setSample] = React.useState(String(config.sample_size));
  const [probe, setProbe] = React.useState(String(config.probe_sites));
  const [cap, setCap] = React.useState(String(config.max_places_requests_day));

  function save() {
    run(() =>
      saveNicheAnalystConfig({
        cities: textToCities(cities),
        niches: [...selected],
        sample_size: Number(sample),
        probe_sites: Number(probe),
        max_places_requests_day: Number(cap),
      })
    );
  }

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Onde e como analisar</CardTitle>
          <CardDescription>
            Para cada nicho × cidade o agente pede empresas ao Google Maps, conta quantas não têm site, visita uma amostra de sites para ver se são fracos e
            calcula a nota. Cada empresa pedida consome cota paga do Google: o teto diário protege a conta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cities">Cidades (uma por linha, ex.: Curitiba, PR)</Label>
              <textarea
                id="cities"
                value={cities}
                onChange={(e) => setCities(e.target.value)}
                disabled={!canAdmin}
                rows={4}
                placeholder={"Curitiba, PR\nLondrina, PR"}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
              />
              <p className="text-xs text-muted-foreground">Até 8 cidades. Sem nenhuma, o agente não tem onde analisar.</p>
            </div>
            <div className="grid grid-cols-3 items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sample">Empresas por análise</Label>
                <Input id="sample" type="number" min={5} max={60} value={sample} onChange={(e) => setSample(e.target.value)} disabled={!canAdmin} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="probe">Sites visitados</Label>
                <Input id="probe" type="number" min={0} max={20} value={probe} onChange={(e) => setProbe(e.target.value)} disabled={!canAdmin} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cap">Teto diário (Google)</Label>
                <Input id="cap" type="number" min={0} max={500} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!canAdmin} />
              </div>
              <p className="col-span-3 text-xs text-muted-foreground">
                20 empresas = 1 requisição por nicho × cidade. Visitar sites mede a qualidade, mas leva alguns segundos cada.
              </p>
            </div>
          </div>

          <fieldset className="space-y-2" disabled={!canAdmin}>
            <legend className="text-sm font-medium">Nichos a analisar</legend>
            <p className="text-xs text-muted-foreground">Nenhum marcado = todos os nichos que a fonte entende.</p>
            <div className="flex flex-wrap gap-2">
              {niches.map((n) => (
                <label
                  key={n.key}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[13px] ${
                    selected.has(n.key) ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-muted-foreground"
                  }`}
                >
                  <input type="checkbox" className="sr-only" checked={selected.has(n.key)} onChange={() => toggle(n.key)} />
                  {n.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-2">
            {canAdmin && (
              <Button onClick={save} disabled={pending}>
                {pending && <Loader2 className="animate-spin" />} Salvar configuração
              </Button>
            )}
            {canRun && (
              <Button variant="secondary" onClick={() => run(runNicheAnalysisNow)} disabled={pending}>
                <Play /> Analisar agora
              </Button>
            )}
            {!runnerAlive && <span className="text-xs text-warning">O runner está parado: a análise espera na fila até ele voltar.</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ranking de nichos</CardTitle>
          <CardDescription>
            Nota de 0 a 100 com fatores publicados. Fixe os que quer priorizar e bana os que não quer prospectar; reanalisar não desfaz sua escolha.
          </CardDescription>
        </CardHeader>
        {targets.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={Radar}
              title="Nenhum nicho analisado ainda"
              description="Cadastre ao menos uma cidade e clique em “Analisar agora” (ou deixe o agente em modo automático)."
            />
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {targets.map((t) => (
              <TargetRow key={t.id} target={t} canAdmin={canAdmin} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TargetRow({ target: t, canAdmin }: { target: NicheTarget; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <li className={`px-5 py-3 ${t.status === "banido" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={scoreVariant(t.score)} className="tabular-nums">
          {t.score}
        </Badge>
        <span className="text-sm font-medium">{t.niche_label}</span>
        <span className="text-sm text-muted-foreground">em {t.city}</span>
        {t.status === "fixado" && <Badge>Fixado</Badge>}
        {t.status === "banido" && <Badge variant="outline">Banido</Badge>}
        {t.source !== "google_places" && <Badge variant="warning">Dados de demonstração</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {formatNumber(t.metrics.total)} empresas · analisado em {formatDateTime(t.analyzed_at)} · válido até {formatDateTime(t.valid_until)}
        </span>
        {canAdmin && (
          <div className="flex gap-1">
            {t.status === "fixado" ? (
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => setNicheTargetStatus(t.id, "auto"))}>
                <PinOff /> Desafixar
              </Button>
            ) : (
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => setNicheTargetStatus(t.id, "fixado"))}>
                <Pin /> Fixar
              </Button>
            )}
            {t.status === "banido" ? (
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => setNicheTargetStatus(t.id, "auto"))}>
                <Undo2 /> Desbanir
              </Button>
            ) : (
              <Button size="xs" variant="danger-ghost" disabled={pending} onClick={() => run(() => setNicheTargetStatus(t.id, "banido"))}>
                <Ban /> Banir
              </Button>
            )}
          </div>
        )}
      </div>
      <details className="mt-2 group">
        <summary className="cursor-pointer text-xs text-primary hover:underline">Por que {t.score} pontos?</summary>
        <div className="mt-2 grid gap-1.5 text-[13px]">
          {t.factors.map((f) => (
            <div key={f.label} className="flex flex-wrap items-baseline gap-x-2">
              <span className="w-44 font-medium">{f.label}</span>
              <span className="w-14 tabular-nums">{f.max > 0 ? `${f.points}/${f.max}` : "—"}</span>
              <span className="text-muted-foreground">{f.note}</span>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {t.evidence.map((e) => (
              <span key={e.label}>
                {e.label}: {e.value}
              </span>
            ))}
          </div>
        </div>
      </details>
    </li>
  );
}
