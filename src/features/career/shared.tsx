"use client";

import * as React from "react";
import { Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { CareerJob, EmailStatus, ProcessingStatus, SelectionStatus } from "@/types/career";

/* ---------- Rótulos ---------- */

export const PROCESSING_LABEL: Record<ProcessingStatus, string> = {
  rascunho: "Rascunho",
  pendente: "Pendente",
  enfileirada: "Enfileirada",
  processando: "Processando",
  acao_manual: "Ação manual necessária",
  resultado_incerto: "Resultado incerto",
  falhou: "Falhou",
  cancelada: "Cancelada",
  concluida: "Concluída",
};

export const PROCESSING_VARIANT: Record<ProcessingStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  rascunho: "neutral",
  pendente: "neutral",
  enfileirada: "info",
  processando: "info",
  acao_manual: "warning",
  resultado_incerto: "warning",
  falhou: "danger",
  cancelada: "neutral",
  concluida: "good",
};

export const EMAIL_LABEL: Record<EmailStatus, string> = {
  aceito: "Aceito pelo provedor",
  enviado: "Enviado",
  entregue: "Entregue",
  atrasado: "Atrasado",
  devolvido: "Devolvido (bounce)",
  reclamacao: "Reclamação (spam)",
};

export const EMAIL_VARIANT: Record<EmailStatus, React.ComponentProps<typeof Badge>["variant"]> = {
  aceito: "info",
  enviado: "info",
  entregue: "good",
  atrasado: "warning",
  devolvido: "danger",
  reclamacao: "danger",
};

export const SELECTION_LABEL: Record<SelectionStatus, string> = {
  registrada: "Candidatura registrada",
  resposta_recebida: "Resposta recebida",
  entrevista: "Entrevista",
  proposta: "Proposta",
  contratado: "Contratado(a)",
  rejeitado: "Rejeitado(a)",
  retirada: "Retirada",
};

export const JOB_KIND_LABEL: Record<CareerJob["kind"], string> = {
  analyze_resume: "Análise do currículo",
  check_links: "Inspeção de links",
  search_jobs: "Busca de vagas",
  campaign_tick: "Ciclo da campanha",
  send_application: "Envio de candidatura",
  recheck_job: "Revalidação de vaga",
};

/* ---------- Progresso de jobs ---------- */

export function JobProgressList({ jobs, kinds }: { jobs: CareerJob[]; kinds?: CareerJob["kind"][] }) {
  const visible = jobs.filter((j) => !kinds || kinds.includes(j.kind));
  if (visible.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {visible.map((job) => {
        const running = job.status === "processando";
        const pct = job.progress && job.progress.total > 0 ? (job.progress.done / job.progress.total) * 100 : running ? 5 : 0;
        return (
          <div key={job.id} className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[13px]">
            <div className="flex items-center gap-2">
              {running ? <Loader2 className="size-3.5 animate-spin text-primary" /> : null}
              <span className="font-medium">{JOB_KIND_LABEL[job.kind]}</span>
              <Badge variant={job.status === "falhou" ? "danger" : running ? "info" : "neutral"} className="ml-auto">
                {job.status === "pendente"
                  ? job.attempts > 0
                    ? `nova tentativa ${job.attempts + 1}/${job.max_attempts}`
                    : "na fila"
                  : job.status === "processando"
                    ? "em execução"
                    : job.status === "falhou"
                      ? "falhou"
                      : job.status}
              </Badge>
            </div>
            {job.progress && (
              <p className="mt-1 text-xs text-muted-foreground">
                {job.progress.label}
                {job.progress.total > 1 ? ` — ${job.progress.done}/${job.progress.total}` : ""}
              </p>
            )}
            {(running || job.status === "pendente") && <Progress className="mt-2" value={pct} />}
            {job.last_error && <p className="mt-1 text-xs text-danger">{job.last_error}</p>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Entrada de listas (tags) ---------- */

export function TagInput({
  value,
  onChange,
  placeholder,
  id,
  max = 20,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
  max?: number;
}) {
  const [draft, setDraft] = React.useState("");
  function commit() {
    const items = draft
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) return;
    onChange([...new Set([...value, ...items])].slice(0, max));
    setDraft("");
  }
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
      <div className="flex flex-wrap gap-1.5">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-2 py-0.5 text-xs">
            {v}
            <button
              type="button"
              aria-label={`Remover ${v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
              className="rounded p-0.5 text-faint-foreground hover:text-foreground cursor-pointer"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={value.length ? "" : placeholder}
          className="h-7 min-w-32 flex-1 border-0 bg-transparent px-1 shadow-none focus:ring-0"
        />
      </div>
    </div>
  );
}

/* ---------- Pequenos utilitários ---------- */

export function Stat({ label, value, hint, className }: { label: string; value: React.ReactNode; hint?: string; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-surface p-4", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-faint-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ScoreRing({ score, size = 72 }: { score: number | null; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = score ?? 0;
  const color = score === null ? "var(--faint-foreground)" : pct >= 75 ? "var(--score-good)" : pct >= 50 ? "var(--score-mid)" : "var(--score-hot)";
  return (
    <svg width={size} height={size} role="img" aria-label={score === null ? "Sem nota" : `Nota ${score} de 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={6} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c - (c * pct) / 100}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fontSize={size / 3.6} fontWeight={600} fill="var(--foreground)">
        {score ?? "—"}
      </text>
    </svg>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
