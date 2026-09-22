"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bookmark, BookmarkCheck, Briefcase, ExternalLink, EyeOff, Link2, Loader2, Search, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/empty-state";
import { flagMatch, importJobUrl, searchJobs } from "@/actions/career";
import { timeAgo } from "@/lib/format";
import type { CareerSnapshot } from "@/services/career/service";
import type { JobMatch, JobPosting } from "@/types/career";
import { CampaignDialog } from "@/features/career/campaign-dialog";
import { JobProgressList, ScoreRing } from "@/features/career/shared";
import { cn } from "@/lib/utils";

type Sort = "score" | "recent";

export function JobsTab({ data }: { data: CareerSnapshot }) {
  const { toast } = useToast();
  const router = useRouter();
  const [searching, setSearching] = React.useState(false);
  const [importUrl, setImportUrl] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [minScore, setMinScore] = React.useState<number>(data.preferences.min_match_score);
  const [sort, setSort] = React.useState<Sort>("score");
  const [query, setQuery] = React.useState("");
  const [showDismissed, setShowDismissed] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [campaignOpen, setCampaignOpen] = React.useState(false);

  const sources = data.config.jobSources.filter((s) => s.configured);
  const appliedKeys = new Set(data.applications.filter((a) => a.processing_status !== "cancelada").map((a) => a.canonical_key));

  const rows = data.jobs
    .map((job) => ({ job, match: data.matches.find((m) => m.job_id === job.id) ?? null }))
    .filter(({ job, match }) => {
      if (!showDismissed && match?.dismissed) return false;
      if ((match?.score ?? 0) < minScore && !match?.saved) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!`${job.title} ${job.company} ${job.location ?? ""}`.toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (sort === "score" ? (b.match?.score ?? 0) - (a.match?.score ?? 0) : (b.job.posted_at ?? b.job.collected_at).localeCompare(a.job.posted_at ?? a.job.collected_at)));

  async function search() {
    setSearching(true);
    const res = await searchJobs();
    setSearching(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Busca enfileirada. Os resultados aparecem conforme as fontes respondem.", "info");
    router.refresh();
  }

  async function doImport() {
    if (!importUrl.trim()) return;
    setImporting(true);
    const res = await importJobUrl(importUrl.trim());
    setImporting(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Vaga importada e avaliada.");
    setImportUrl("");
    router.refresh();
  }

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="grid min-w-0 gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <p className="text-sm font-medium">Fontes de vagas</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {data.config.jobSources.map((s) => (
                <Badge key={s.id} variant={s.configured ? (s.isDemo ? "warning" : "good") : "neutral"} title={s.hint ?? s.coverage} className="max-w-full whitespace-normal">
                  {s.name}{s.isDemo ? " (demo)" : ""} — {s.configured ? s.coverage : "não configurada"}
                </Badge>
              ))}
            </div>
            {sources.length === 0 && (
              <p className="mt-2 text-[13px] text-warning">Nenhuma fonte de busca configurada. A importação por URL continua disponível; nenhum resultado é fabricado.</p>
            )}
            {!data.profile && <p className="mt-2 text-[13px] text-muted-foreground">Envie um currículo para habilitar a busca.</p>}
          </div>
          <div className="flex min-w-0 flex-col gap-2 lg:items-end">
            <Button className="w-full lg:w-auto" disabled={searching || !data.profile || sources.length === 0} onClick={search}>
              {searching ? <Loader2 className="animate-spin" /> : <Search />} Buscar vagas compatíveis
            </Button>
            <div className="flex w-full min-w-0 gap-2 lg:w-96">
              <Input aria-label="URL da vaga" placeholder="Importar vaga pela URL do anúncio" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doImport()} />
              <Button variant="secondary" disabled={importing || !importUrl.trim()} onClick={doImport} aria-label="Importar">
                {importing ? <Loader2 className="animate-spin" /> : <Link2 />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <JobProgressList jobs={data.activeJobs} kinds={["search_jobs"]} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Label htmlFor="jobs-q" className="sr-only">Filtrar</Label>
          <Input id="jobs-q" placeholder="Filtrar por cargo, empresa ou local" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="w-36">
          <Label htmlFor="jobs-min" className="text-xs">Nota mínima</Label>
          <Input id="jobs-min" type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
        </div>
        <div className="w-44">
          <Label className="text-xs">Ordenar por</Label>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger aria-label="Ordenar"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="score">Compatibilidade</SelectItem>
              <SelectItem value="recent">Mais recentes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-[13px] cursor-pointer">
          <Checkbox checked={showDismissed} onCheckedChange={(c) => setShowDismissed(Boolean(c))} /> Mostrar descartadas
        </label>
        <div className="flex w-full items-center justify-end gap-2 sm:ml-auto sm:w-auto">
          <span className="text-[13px] text-muted-foreground">{selected.size} selecionada(s)</span>
          <Button disabled={selected.size === 0 || !data.profile} onClick={() => setCampaignOpen(true)}>
            <Send /> Iniciar candidaturas
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title={data.jobs.length === 0 ? "Nenhuma vaga ainda" : "Nenhuma vaga com estes filtros"}
          description={data.jobs.length === 0 ? "Busque nas fontes configuradas ou importe uma vaga pela URL." : "Reduza a nota mínima ou limpe o filtro."}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map(({ job, match }) => (
            <JobRow
              key={job.id}
              job={job}
              match={match}
              applied={appliedKeys.has(job.canonical_key)}
              selected={selected.has(job.id)}
              onSelect={(on) => toggle(job.id, on)}
            />
          ))}
        </ul>
      )}

      {campaignOpen && data.profile && (
        <CampaignDialog
          open={campaignOpen}
          onOpenChange={(o) => {
            setCampaignOpen(o);
            if (!o) setSelected(new Set());
          }}
          data={data}
          jobIds={[...selected]}
        />
      )}
    </div>
  );
}

function JobRow({ job, match, applied, selected, onSelect }: { job: JobPosting; match: JobMatch | null; applied: boolean; selected: boolean; onSelect: (on: boolean) => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const blocked = (match?.blocked_by.length ?? 0) > 0;

  async function flag(patch: { saved?: boolean; dismissed?: boolean }) {
    if (!match) return;
    const res = await flagMatch(match.id, patch);
    if (!res.ok) return toast(res.error, "error");
    router.refresh();
  }

  return (
    <li className={cn("rounded-xl border bg-surface p-4 shadow-card", selected ? "border-primary" : "border-border", match?.dismissed && "opacity-60")}>
      <div className="flex gap-3">
        <div className="pt-1">
          <Checkbox aria-label={`Selecionar ${job.title} em ${job.company}`} checked={selected} disabled={applied || blocked || job.status === "encerrada"} onCheckedChange={(c) => onSelect(Boolean(c))} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold">{job.title}</h3>
            <span className="text-[13px] text-muted-foreground">· {job.company}</span>
            {job.source === "demo" && <Badge variant="warning">demo</Badge>}
            {job.status === "encerrada" && <Badge variant="danger">encerrada</Badge>}
            {applied && <Badge variant="info">já candidatado</Badge>}
            {match?.saved && <Badge variant="good">salva</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[job.location, job.work_mode, job.contract_type, job.salary].filter(Boolean).join(" · ")}
            {job.posted_at ? ` · publicada ${timeAgo(job.posted_at)}` : ` · coletada ${timeAgo(job.collected_at)}`} · fonte: {job.source}
          </p>
          <p className="mt-1 text-xs">
            {job.application_email ? (
              <span className="text-primary-soft-fg">E-mail de candidatura publicado: {job.application_email}</span>
            ) : (
              <span className="text-muted-foreground">Sem e-mail publicado — candidatura pelo link (ação manual)</span>
            )}
          </p>
          {match && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{match.explanation}</summary>
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                <MatchList title="Atende" items={match.met} tone="good" />
                <MatchList title="Lacunas" items={match.gaps} tone="danger" />
                <MatchList title="Não verificável" items={match.unknown} tone="neutral" />
              </div>
              {blocked && <p className="mt-2 text-xs text-danger">Bloqueada: {match.blocked_by.join("; ")}</p>}
            </details>
          )}
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground">Descrição</summary>
            <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-hover p-2 text-xs">{job.description.slice(0, 4000)}</p>
            <p className="mt-1 text-[11px] text-faint-foreground">Origem: {job.origin_evidence}</p>
          </details>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ScoreRing score={match?.score ?? null} size={52} />
          <div className="flex gap-1">
            <Button size="icon-sm" variant="ghost" asChild aria-label="Abrir anúncio">
              <a href={job.url} target="_blank" rel="noopener noreferrer"><ExternalLink /></a>
            </Button>
            {match && (
              <>
                <Button size="icon-sm" variant="ghost" aria-label={match.saved ? "Remover dos salvos" : "Salvar vaga"} onClick={() => flag({ saved: !match.saved })}>
                  {match.saved ? <BookmarkCheck className="text-primary" /> : <Bookmark />}
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={match.dismissed ? "Restaurar vaga" : "Descartar vaga"} onClick={() => flag({ dismissed: !match.dismissed })}>
                  <EyeOff className={match.dismissed ? "text-danger" : ""} />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function MatchList({ title, items, tone }: { title: string; items: string[]; tone: "good" | "danger" | "neutral" }) {
  return (
    <div>
      <p className={cn("font-medium", tone === "good" ? "text-score-good" : tone === "danger" ? "text-score-hot" : "text-muted-foreground")}>{title} ({items.length})</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
        {items.slice(0, 6).map((i, k) => <li key={k}>{i}</li>)}
        {items.length > 6 && <li>+{items.length - 6}</li>}
      </ul>
    </div>
  );
}
