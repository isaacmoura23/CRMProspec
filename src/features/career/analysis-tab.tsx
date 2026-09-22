"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, FileDown, Link2, Loader2, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/empty-state";
import { buildRevisedResume, decideSuggestion } from "@/actions/career";
import { formatDateTime } from "@/lib/format";
import type { CareerSnapshot } from "@/services/career/service";
import type { LinkCheck, ResumeAnalysis, ResumeSuggestion } from "@/types/career";
import { JobProgressList, ScoreRing } from "@/features/career/shared";
import { cn } from "@/lib/utils";

const PRIORITY_VARIANT = { alta: "danger", media: "warning", baixa: "neutral" } as const;
const LINK_STATUS: Record<LinkCheck["status"], { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }> = {
  pendente: { label: "Pendente", variant: "neutral" },
  concluido: { label: "Acesso concluído", variant: "good" },
  parcial: { label: "Acesso parcial", variant: "warning" },
  bloqueado: { label: "Bloqueado", variant: "warning" },
  quebrado: { label: "Quebrado", variant: "danger" },
};

export function AnalysisTab({ data }: { data: CareerSnapshot }) {
  const [versionId, setVersionId] = React.useState<string | null>(data.profile?.resume_version_id ?? data.resumes[0]?.id ?? null);
  const analysis = data.analyses.find((a) => a.resume_version_id === versionId) ?? null;
  const version = data.resumes.find((r) => r.id === versionId) ?? null;
  const links = data.linkChecks.filter((l) => l.resume_version_id === versionId);
  const running = data.activeJobs.filter((j) => (j.kind === "analyze_resume" || j.kind === "check_links") && j.payload.resume_version_id === versionId);

  if (data.resumes.length === 0) {
    return <EmptyState icon={Sparkles} title="Nada para analisar ainda" description="Envie um currículo na aba “Meu currículo”." />;
  }

  return (
    <div className="space-y-6">
      {data.resumes.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Versão:</span>
          {data.resumes.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setVersionId(r.id)}
              className={cn("rounded-md border px-2.5 py-1 cursor-pointer", r.id === versionId ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border hover:bg-surface-hover")}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <JobProgressList jobs={running} />

      {!analysis ? (
        <EmptyState
          icon={Sparkles}
          title={running.length ? "Analisando…" : version && !["ok", "parcial"].includes(version.text_status) ? "Esta versão não tem texto legível" : "Análise ainda não executada"}
          description={version?.text_note ?? "A análise começa automaticamente depois do envio. Se não iniciou, use “Reanalisar” na lista de versões."}
        />
      ) : analysis.status === "falhou" ? (
        <EmptyState icon={X} title="A análise falhou" description={analysis.error ?? "Tente reanalisar a versão."} />
      ) : (
        <>
          <ScoreCard analysis={analysis} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <SuggestionsCard analysis={analysis} />
            <div className="space-y-6">
              <IssuesCard analysis={analysis} />
              <LinksCard links={links} pendingCount={Math.max(0, (version?.links.length ?? 0) - links.length)} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ScoreCard({ analysis }: { analysis: ResumeAnalysis }) {
  return (
    <Card>
      <CardContent className="grid gap-6 p-5 md:grid-cols-[auto_1fr]">
        <div className="flex flex-col items-center gap-2">
          <ScoreRing score={analysis.score} size={96} />
          <p className="text-center text-xs text-muted-foreground">Qualidade geral<br />(não é aderência a vaga)</p>
        </div>
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold">Critérios e pesos</h3>
            <span className="text-xs text-muted-foreground">
              {analysis.context.profession ? `${analysis.context.profession} · ` : ""}
              {analysis.context.seniority ? `${analysis.context.seniority} · ` : ""}
              {analysis.context.country ?? "país não identificado"} · {analysis.model} · {formatDateTime(analysis.finished_at)}
            </span>
          </div>
          <ul className="mt-3 space-y-2.5">
            {analysis.criteria.map((c) => (
              <li key={c.key}>
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span>
                    {c.label} <span className="text-faint-foreground">· peso {c.weight}</span>
                  </span>
                  <span className="font-medium tabular-nums">{c.score === null ? "não avaliado" : `${c.score}/100`}</span>
                </div>
                <Progress value={c.score ?? 0} className="mt-1" />
                {(c.evidence.length > 0 || c.note) && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">Evidências</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                      {c.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      {c.note && <li className="text-warning">{c.note}</li>}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {analysis.not_evaluated.length > 0 && (
            <div className="mt-4 rounded-lg bg-surface-hover p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Não avaliado / observações</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {analysis.not_evaluated.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-faint-foreground">A nota é a média ponderada dos critérios medidos; não é certificação nem probabilidade de contratação.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function IssuesCard({ analysis }: { analysis: ResumeAnalysis }) {
  const sorted = [...analysis.issues].sort((a, b) => ({ alta: 0, media: 1, baixa: 2 })[a.priority] - ({ alta: 0, media: 1, baixa: 2 })[b.priority]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Problemas priorizados</CardTitle>
        <CardDescription>{sorted.length} ponto(s) de atenção.</CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? <p className="text-[13px] text-muted-foreground">Nenhum problema estrutural identificado.</p> : (
          <ul className="space-y-2.5">
            {sorted.map((i) => (
              <li key={i.id} className="text-[13px]">
                <div className="flex items-start gap-2">
                  <Badge variant={PRIORITY_VARIANT[i.priority]} className="mt-0.5 shrink-0">{i.priority}</Badge>
                  <div>
                    <p className="font-medium">{i.title}{i.page ? <span className="ml-1 text-xs font-normal text-faint-foreground">p. {i.page}</span> : null}</p>
                    <p className="text-muted-foreground">{i.detail}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionsCard({ analysis }: { analysis: ResumeAnalysis }) {
  const { toast } = useToast();
  const router = useRouter();
  const [building, setBuilding] = React.useState(false);
  const accepted = analysis.suggestions.filter((s) => s.status === "aceita").length;
  const sorted = [...analysis.suggestions].sort((a, b) => ({ alta: 0, media: 1, baixa: 2 })[a.priority] - ({ alta: 0, media: 1, baixa: 2 })[b.priority]);

  async function build() {
    setBuilding(true);
    const res = await buildRevisedResume(analysis.id);
    setBuilding(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Versão revisada gerada. Veja em “Meu currículo”.");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Sugestões de melhoria</CardTitle>
          <CardDescription>Aceite, edite ou rejeite cada uma. Nada é inventado: onde falta dado, há um espaço entre colchetes para você preencher.</CardDescription>
        </div>
        <Button size="sm" variant="secondary" disabled={accepted === 0 || building} onClick={build}>
          {building ? <Loader2 className="animate-spin" /> : <FileDown />} Gerar PDF revisado ({accepted})
        </Button>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? <p className="text-[13px] text-muted-foreground">Nenhuma sugestão de texto para esta versão.</p> : (
          <ul className="space-y-3">
            {sorted.map((s) => <SuggestionItem key={s.id} analysisId={analysis.id} s={s} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionItem({ analysisId, s }: { analysisId: string; s: ResumeSuggestion }) {
  const { toast } = useToast();
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(s.edited ?? s.suggested);
  const [busy, setBusy] = React.useState(false);
  const needsInput = /\[[^\]]+\]/.test(s.edited ?? s.suggested);

  async function decide(status: ResumeSuggestion["status"], edited: string | null) {
    setBusy(true);
    const res = await decideSuggestion({ analysisId, suggestionId: s.id, status, edited });
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    setEditing(false);
    router.refresh();
  }

  return (
    <li className={cn("rounded-lg border p-3 text-[13px]", s.status === "aceita" ? "border-primary/40 bg-primary-soft/30" : s.status === "rejeitada" ? "border-border opacity-60" : "border-border")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={PRIORITY_VARIANT[s.priority]}>{s.priority}</Badge>
        {s.page && <span className="text-xs text-faint-foreground">p. {s.page}</span>}
        {s.needs_user_input && <Badge variant="info">precisa do seu dado</Badge>}
        {s.status !== "pendente" && <Badge variant={s.status === "aceita" ? "good" : "neutral"} className="ml-auto">{s.status}</Badge>}
      </div>
      <p className="mt-2 font-medium">{s.problem}</p>
      <p className="text-xs text-muted-foreground">{s.rationale}</p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div className="rounded-md bg-surface-hover p-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint-foreground">Antes</p>
          <p className="whitespace-pre-wrap text-xs">{s.original}</p>
        </div>
        <div className="rounded-md bg-surface-hover p-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint-foreground">Depois</p>
          {editing ? (
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className="text-xs" />
          ) : (
            <p className="whitespace-pre-wrap text-xs">{s.edited ?? s.suggested}</p>
          )}
        </div>
      </div>
      {needsInput && s.status === "aceita" && <p className="mt-1 text-xs text-warning">Preencha os trechos entre colchetes: até lá esta sugestão não entra no PDF revisado.</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {editing ? (
          <>
            <Button size="xs" disabled={busy} onClick={() => decide("aceita", text)}><Check /> Salvar e aceitar</Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
          </>
        ) : (
          <>
            {s.status !== "aceita" && <Button size="xs" disabled={busy} onClick={() => decide("aceita", s.edited)}><Check /> Aceitar</Button>}
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>Editar</Button>
            {s.status !== "rejeitada" && <Button size="xs" variant="ghost" disabled={busy} onClick={() => decide("rejeitada", s.edited)}><X /> Rejeitar</Button>}
            {s.status !== "pendente" && <Button size="xs" variant="ghost" disabled={busy} onClick={() => decide("pendente", s.edited)}>Desfazer</Button>}
          </>
        )}
      </div>
    </li>
  );
}

function LinksCard({ links, pendingCount }: { links: LinkCheck[]; pendingCount: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Links inspecionados</CardTitle>
        <CardDescription>
          Cada link é visitado com orçamento fixo de leitura. Login e bloqueios são respeitados, nunca contornados.
          {pendingCount > 0 ? ` ${pendingCount} link(s) ainda não inspecionado(s).` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {links.length === 0 ? <p className="text-[13px] text-muted-foreground">Nenhum link encontrado no PDF (texto ou anotações).</p> : (
          <ul className="space-y-3">
            {links.map((l) => {
              const st = LINK_STATUS[l.status];
              return (
                <li key={l.id} className="rounded-lg border border-border p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link2 className="size-3.5 text-muted-foreground" />
                    <a href={l.url} target="_blank" rel="noopener noreferrer" className="max-w-full truncate font-medium hover:underline">
                      {l.url.replace(/^https?:\/\//, "")}
                    </a>
                    <Badge variant="neutral">{l.kind}</Badge>
                    <Badge variant={st.variant}>{st.label}</Badge>
                    {l.http_status && <span className="text-xs text-faint-foreground">HTTP {l.http_status}</span>}
                    {l.consistent_with_resume === false && <Badge variant="warning">inconsistente com o currículo</Badge>}
                    {l.consistent_with_resume === true && <Badge variant="good">coerente</Badge>}
                  </div>
                  {l.final_url && l.final_url !== l.url && (
                    <p className="mt-1 truncate text-xs text-muted-foreground"><ExternalLink className="mr-1 inline size-3" />{l.final_url}</p>
                  )}
                  {l.content_summary && <p className="mt-1 text-xs">{l.content_summary}</p>}
                  {l.checked_at && <p className="text-[11px] text-faint-foreground">Verificado em {formatDateTime(l.checked_at)}</p>}
                  {l.evidence.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Evidências ({l.evidence.length})</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{l.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                    </details>
                  )}
                  {l.limitations.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-warning">{l.limitations.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  )}
                  {l.suggestions.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">{l.suggestions.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
