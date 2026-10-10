"use client";

import * as React from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { prospectNow, saveProspectorConfig } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import type { ProspectorConfig } from "@/agents/config";
import type { NicheTarget } from "@/types/agents";

/** Critérios que o agente aceita. “Sem site ou site fraco” é o alvo padrão do negócio. */
const FILTER_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: "weakWebsite", label: "Sem site ou site fraco", hint: "O alvo: quem mais precisa de um site novo." },
  { key: "activeBusiness", label: "Empresa ativa", hint: "Exclui as que o Google marca como fechadas." },
  { key: "hasPhone", label: "Possui telefone", hint: "Sem telefone não há como abordar." },
  { key: "hasReviews", label: "Com avaliações", hint: "Negócio que opera de verdade." },
  { key: "hasWhatsapp", label: "Possui WhatsApp", hint: "Só aparece se o site da empresa publica o número — raro em quem não tem site." },
  { key: "hasEmail", label: "Possui e-mail", hint: "Só o do domínio da empresa; raro." },
];

export function ProspectorPanel({
  config,
  niches,
  targets,
  canAdmin,
  canRun,
  runnerAlive,
}: {
  config: ProspectorConfig;
  niches: Array<{ key: string; label: string }>;
  targets: NicheTarget[];
  canAdmin: boolean;
  canRun: boolean;
  runnerAlive: boolean;
}) {
  const { run, pending } = useAgentAction();
  const [quantityPerRun, setQuantityPerRun] = React.useState(String(config.quantity_per_run));
  const [leadsCap, setLeadsCap] = React.useState(String(config.daily_leads_cap));
  const [placesCap, setPlacesCap] = React.useState(String(config.max_places_requests_day));
  const [minScore, setMinScore] = React.useState(String(config.min_niche_score));
  const [cooldown, setCooldown] = React.useState(String(config.cooldown_days));
  const [filters, setFilters] = React.useState<Record<string, boolean>>({ ...config.filters } as Record<string, boolean>);
  const [sweep, setSweep] = React.useState(config.sweep);
  const [sweepScope, setSweepScope] = React.useState<string>(config.sweep_scope);
  const [sweepNiches, setSweepNiches] = React.useState(String(config.sweep_niches));

  const best = targets.find((t) => t.status !== "banido");
  const [niche, setNiche] = React.useState(best?.niche ?? niches[0]?.key ?? "");
  const [city, setCity] = React.useState(best?.city ?? "");
  const [qty, setQty] = React.useState(String(config.quantity_per_run));

  function save() {
    run(() =>
      saveProspectorConfig({
        quantity_per_run: Number(quantityPerRun),
        daily_leads_cap: Number(leadsCap),
        max_places_requests_day: Number(placesCap),
        min_niche_score: Number(minScore),
        cooldown_days: Number(cooldown),
        filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        sweep,
        sweep_scope: sweepScope,
        sweep_niches: Number(sweepNiches),
      })
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Prospectar agora</CardTitle>
          <CardDescription>
            Roda uma prospecção já, com os critérios abaixo. O clique é a sua aprovação — vale mesmo com o agente em modo de aprovação.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid items-end gap-3 md:grid-cols-[1.2fr_1.2fr_100px_auto]">
            <div className="space-y-1.5">
              <Label>Nicho</Label>
              <Select value={niche} onValueChange={setNiche} disabled={!canRun}>
                <SelectTrigger aria-label="Nicho">
                  <SelectValue placeholder="Escolha um nicho" />
                </SelectTrigger>
                <SelectContent>
                  {niches.map((n) => (
                    <SelectItem key={n.key} value={n.key}>
                      {n.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-city">Cidade</Label>
              <Input id="p-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Curitiba" disabled={!canRun} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-qty">Leads</Label>
              <Input id="p-qty" type="number" min={1} max={100} value={qty} onChange={(e) => setQty(e.target.value)} disabled={!canRun} />
            </div>
            <Button
              disabled={!canRun || pending || !niche || city.trim().length < 2}
              onClick={() => run(() => prospectNow({ niche, city: city.trim(), country: "Brasil", quantity: Number(qty) || undefined }))}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Play />} Prospectar
            </Button>
          </div>
          {!runnerAlive && <p className="mt-2 text-xs text-warning">O runner está parado: a prospecção espera na fila até ele voltar.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Varredura do Brasil</CardTitle>
          <CardDescription>
            Além dos nichos que o Analista ranqueou, percorre cidades do país aos poucos, procurando só empresas sem site (inclui ficha cujo “site” é um Instagram, Facebook ou Linktree). Começa pelas cidades ainda não varridas, capitais primeiro, e respeita os tetos diários — não promete cobrir o Brasil numa execução. O progresso está em “Lista de prospecção”.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={sweep} onChange={(e) => setSweep(e.target.checked)} disabled={!canAdmin} />
            <span>
              <span className="block text-[13px] font-medium">Ligar a varredura contínua</span>
              <span className="block text-xs text-muted-foreground">Cada busca gasta requisições pagas ao Google (veja os tetos abaixo).</span>
            </span>
          </label>
          <div className="grid max-w-xl gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Onde varrer</Label>
              <Select value={sweepScope} onValueChange={setSweepScope} disabled={!canAdmin}>
                <SelectTrigger aria-label="Onde varrer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="capitais">Só as 27 capitais</SelectItem>
                  <SelectItem value="principais">Capitais e grandes cidades (~110)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sweep-niches">Nichos na varredura</Label>
              <Input id="sweep-niches" type="number" min={1} max={10} value={sweepNiches} onChange={(e) => setSweepNiches(e.target.value)} disabled={!canAdmin} />
              <p className="text-xs text-muted-foreground">Os de maior nota do Analista de Nicho.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Critérios e tetos</CardTitle>
          <CardDescription>
            Valem para o que o agente inicia sozinho. Os tetos diários protegem a cota do Google e a sua base: ao estourar, a tarefa espera o dia seguinte.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <fieldset className="space-y-2" disabled={!canAdmin}>
            <legend className="text-sm font-medium">Quem entra</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {FILTER_OPTIONS.map((f) => (
                <label key={f.key} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--color-primary)]"
                    checked={Boolean(filters[f.key])}
                    onChange={(e) => setFilters((prev) => ({ ...prev, [f.key]: e.target.checked }))}
                  />
                  <span>
                    <span className="block text-[13px] font-medium">{f.label}</span>
                    <span className="block text-xs text-muted-foreground">{f.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ["Leads por execução", quantityPerRun, setQuantityPerRun, 1, 100],
              ["Teto diário de leads", leadsCap, setLeadsCap, 0, 500],
              ["Teto diário (Google)", placesCap, setPlacesCap, 0, 1000],
              ["Nota mínima do nicho", minScore, setMinScore, 0, 100],
              ["Carência (dias)", cooldown, setCooldown, 0, 90],
            ].map(([label, value, setter, min, max]) => (
              <div key={label as string} className="space-y-1.5">
                <Label>{label as string}</Label>
                <Input
                  type="number"
                  min={min as number}
                  max={max as number}
                  value={value as string}
                  onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                  disabled={!canAdmin}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Uma busca com critério raro (como “sem site ou site fraco”) pode varrer até 240 empresas e custar até 12 requisições ao Google. O agente confere o
            pior caso contra o teto antes de começar. Nichos fixados ignoram a nota mínima; a carência evita voltar ao mesmo nicho × cidade logo em seguida.
          </p>

          {canAdmin && (
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Salvar configuração
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
