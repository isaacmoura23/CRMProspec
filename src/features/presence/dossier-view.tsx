import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

/** Só endereços http(s) viram link: o que veio de páginas de terceiros não pode ser `javascript:`. */
const safeHref = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);
import type { DossierFinding, DossierSourceStatus, LeadDossier } from "@/types/agents";

const SOURCE_BADGE: Record<DossierSourceStatus, "good" | "warning" | "danger" | "outline"> = {
  concluida: "good",
  parcial: "warning",
  bloqueada: "danger",
  pendente: "outline",
};
const SOURCE_LABEL: Record<DossierSourceStatus, string> = { concluida: "Concluída", parcial: "Parcial", bloqueada: "Bloqueada", pendente: "Pendente" };

const KIND_LABEL: Record<DossierFinding["kind"], string> = {
  oferta: "Oferta",
  identidade: "Identidade",
  contato: "Contato",
  presenca: "Presença",
  destaque: "Destaque",
  lacuna: "Lacuna",
  problema: "Problema",
};
const KIND_BADGE: Record<DossierFinding["kind"], "good" | "info" | "warning" | "danger" | "neutral"> = {
  oferta: "info",
  identidade: "neutral",
  contato: "neutral",
  presenca: "info",
  destaque: "good",
  lacuna: "warning",
  problema: "danger",
};

const QUALITY_LABEL: Record<string, string> = { nenhum: "Sem site", ruim: "Ruim", desatualizado: "Desatualizado", bom: "Bom", desconhecido: "Desconhecido" };

/** Confiança em faixas legíveis (o número exato é falsa precisão). */
function confidenceLabel(n: number): { text: string; variant: "good" | "warning" | "danger" } {
  if (n >= 80) return { text: "Alta", variant: "good" };
  if (n >= 50) return { text: "Média", variant: "warning" };
  return { text: "Baixa", variant: "danger" };
}

export function DossierView({ dossier: d }: { dossier: LeadDossier }) {
  const conf = confidenceLabel(d.confidence);
  const a = d.assessment;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge variant={conf.variant}>Confiança {conf.text.toLowerCase()} ({d.confidence})</Badge>
        {d.status === "parcial" && <Badge variant="warning">Dossiê parcial</Badge>}
        <span className="text-xs text-muted-foreground">Montado em {formatDateTime(d.updated_at)} · vale até {formatDateTime(d.valid_until)}</span>
      </div>
      <p className="text-[13px] text-muted-foreground">{d.summary}</p>

      <section aria-label="Fontes consultadas">
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fontes</h4>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {d.sources.map((s) => (
            <li key={s.key} className="rounded-lg border border-border px-3 py-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.label}</span>
                <Badge variant={SOURCE_BADGE[s.status]}>{SOURCE_LABEL[s.status]}</Badge>
              </div>
              {s.note && <p className="mt-0.5 text-xs text-muted-foreground">{s.note}</p>}
              {safeHref(s.url) && (
                <a href={safeHref(s.url)!} target="_blank" rel="noopener noreferrer" className="mt-0.5 block truncate text-xs text-primary hover:underline">
                  {s.url}
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      {a && (
        <section aria-label="Avaliação do site">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avaliação do site</h4>
          <p className="mb-2 text-[13px]">
            Nota <strong>{a.total}/100</strong> · qualidade: <strong>{QUALITY_LABEL[d.website_quality_before] ?? d.website_quality_before}</strong> →{" "}
            <strong>{QUALITY_LABEL[d.website_quality_after] ?? d.website_quality_after}</strong>
            <span className="ml-2 text-xs text-muted-foreground">({a.method === "regras" ? "avaliação por regras" : "regras + leitura visual"})</span>
          </p>
          {a.rubric.length > 0 && (
            <ul className="space-y-1">
              {a.rubric.map((r) => (
                <li key={r.key} className="flex items-start gap-3 text-[13px]">
                  <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{r.score}/5</span>
                  <span>
                    <span className="font-medium">{r.label}.</span> <span className="text-muted-foreground">{r.evidence}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {a.reasons.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Motivos: {a.reasons.join("; ")}.</p>}
        </section>
      )}

      <section aria-label="Afirmações e evidências">
        <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Afirmações, cada uma com a evidência</h4>
        {d.findings.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nenhuma afirmação comprovada ainda.</p>
        ) : (
          <ul className="space-y-2">
            {d.findings.map((f) => (
              <li key={f.id} className="rounded-lg bg-surface-hover px-3 py-2 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={KIND_BADGE[f.kind]}>{KIND_LABEL[f.kind]}</Badge>
                  <span>{f.claim}</span>
                </div>
                <ul className="mt-1 space-y-0.5 pl-1">
                  {f.evidence.map((e, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{e.source}</span>: “{e.excerpt}”
                      {safeHref(e.url) && (
                        <>
                          {" "}
                          <a href={safeHref(e.url)!} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            abrir
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
