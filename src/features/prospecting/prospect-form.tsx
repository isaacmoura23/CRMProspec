"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Compass,
  Loader2,
  MapPin,
  Search,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { getProspectingJob, startProspecting } from "@/actions/prospecting";
import type { JobStep, ProspectingJob } from "@/types";
import { NICHES } from "@/providers/directory-data";
import { FILTER_LABEL, filterWarnings } from "@/services/lead-filter";
import { cn } from "@/lib/utils";

/**
 * O Text Search do Google devolve no máximo 60 lugares por busca.
 * Outros providers (como o de demonstração) suportam mais.
 */
/**
 * Teto do formulário e da server action. Acima de 60 o provider precisa
 * somar variações da consulta (mais chamadas cobradas e mais tempo), por
 * isso o aviso ao lado dos números maiores.
 */
const MAX_QUANTITY = 200;
const QUANTITIES = [25, 50, 100, 200];

/**
 * Cada critério diz de onde vem o dado: Instagram, WhatsApp e e-mail são
 * descobertos visitando o site da empresa, então combiná-los com "Sem site"
 * quase sempre devolve lista vazia. Dizer isso no rótulo evita a espera
 * inútil.
 */
const CHARACTERISTICS: Array<{ key: string; label: string; hint: string }> = [
  { key: "hasPhone", label: "Possui telefone", hint: "Vem do Google — quase toda empresa tem." },
  { key: "hasWhatsapp", label: "Possui WhatsApp", hint: "Encontrado no site da empresa." },
  { key: "hasInstagram", label: "Possui Instagram", hint: "Encontrado no site da empresa." },
  { key: "hasEmail", label: "Possui e-mail", hint: "Só o do domínio da empresa; raro, cerca de metade dos que têm site." },
  { key: "noWebsite", label: "Sem site", hint: "Oportunidade clássica, mas rara em alguns nichos (imobiliárias, clínicas)." },
  { key: "hasWebsite", label: "Possui site", hint: "Não combina com “Sem site”." },
  { key: "badWebsite", label: "Site potencialmente ruim", hint: "Site que não abre bem no celular ou parece antigo." },
  { key: "activeBusiness", label: "Empresa ativa", hint: "Exclui as que o Google marca como fechadas." },
  { key: "hasReviews", label: "Empresa com avaliações", hint: "Tem ao menos uma avaliação no Google." },
  { key: "strongSocial", label: "Presença forte em redes sociais", hint: "Instagram ativo — depende de achar o perfil pelo site." },
];

export function ProspectForm({
  providerName,
  providerId,
}: {
  providerName: string;
  providerId: string;
}) {
  const isLive = providerId === "google_places";
  const router = useRouter();
  const [niche, setNiche] = React.useState("imobiliaria");
  const [customNiche, setCustomNiche] = React.useState("");
  const [country, setCountry] = React.useState("Brasil");
  const [state, setState] = React.useState("");
  const [city, setCity] = React.useState("");
  const [quantity, setQuantity] = React.useState<number>(25);
  const [customQty, setCustomQty] = React.useState("");
  const [filters, setFilters] = React.useState<Record<string, boolean>>({
    activeBusiness: true,
  });
  const [campaignName, setCampaignName] = React.useState("");

  const [job, setJob] = React.useState<ProspectingJob | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lostJob, setLostJob] = React.useState(false);

  const running = job && !lostJob && (job.status === "queued" || job.status === "processing");
  // Combinações que quase sempre voltam vazias — avisadas antes da espera,
  // não depois. Ver services/lead-filter.ts para o porquê de cada uma.
  const avisosDeFiltro = filterWarnings(filters);

  // polling do job em execução — progresso real, nunca simulado.
  // Se o job sumir (a execução que o criou foi encerrada) ou o polling
  // falhar repetidamente, a tela precisa sair do estado "processando"
  // em vez de girar para sempre.
  React.useEffect(() => {
    if (!job || !running) return;
    const jobId = job.id;
    let misses = 0;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const fresh = await getProspectingJob(jobId);
        if (cancelled) return;
        if (fresh) {
          misses = 0;
          setJob(fresh);
          return;
        }
        misses += 1;
      } catch {
        misses += 1;
      }
      if (!cancelled && misses >= 8) {
        setLostJob(true);
      }
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [job?.id, running]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setError(null);
    const nicheValue = niche === "custom" ? customNiche.trim() : niche;
    if (!nicheValue) {
      setError("Informe o nicho que deseja prospectar.");
      return;
    }
    if (!city.trim()) {
      setError("Informe a cidade onde deseja prospectar.");
      return;
    }
    const qty = quantity === -1 ? parseInt(customQty, 10) : quantity;
    if (!qty || qty < 1 || qty > MAX_QUANTITY) {
      setError(`Quantidade inválida (1 a ${MAX_QUANTITY}).`);
      return;
    }
    setStarting(true);
    try {
      const res = await startProspecting({
        niche: nicheValue,
        country,
        state: state.trim() || undefined,
        city: city.trim(),
        quantity: qty,
        campaignName: campaignName.trim() || undefined,
        filters,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const fresh = await getProspectingJob(res.jobId);
      if (!fresh) {
        setError(
          "A busca foi iniciada, mas não conseguimos acompanhar o progresso. Confira a lista de leads em instantes."
        );
        return;
      }
      setLostJob(false);
      setJob(fresh);
    } catch {
      setError("Não conseguimos iniciar a busca agora. Tente novamente.");
    } finally {
      setStarting(false);
    }
  }

  function resetSearch() {
    setJob(null);
    setLostJob(false);
  }

  if (job) {
    return (
      <JobProgress
        job={job}
        lost={lostJob}
        onNewSearch={resetSearch}
        onSeeLeads={() => router.push("/leads?ordenar=score")}
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>O que você procura?</CardTitle>
            <CardDescription>Escolha o nicho e a região onde quer encontrar oportunidades.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Nicho</Label>
                <Select value={niche} onValueChange={setNiche}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um nicho" />
                  </SelectTrigger>
                  <SelectContent>
                    {NICHES.map((n) => (
                      <SelectItem key={n.key} value={n.key}>
                        {n.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Outro (personalizado)…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {niche === "custom" && (
                <div className="space-y-1.5">
                  <Label>Nicho personalizado</Label>
                  <Input
                    value={customNiche}
                    onChange={(e) => setCustomNiche(e.target.value)}
                    placeholder="Ex.: pet shop, escola de idiomas…"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label>País</Label>
                <Select value={country} onValueChange={setCountry}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["Brasil", "Portugal", "Angola", "Moçambique"].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Estado / Distrito (opcional)</Label>
                <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="Ex.: SP, Porto…" />
              </div>
              <div className="space-y-1.5">
                <Label>Cidade</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Ex.: São Paulo, Porto…" />
              </div>
              <div className="space-y-1.5">
                <Label>Campanha (opcional)</Label>
                <Input
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Ex.: Imobiliárias Porto — Setembro"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Quantidade de empresas</Label>
              <div className="flex flex-wrap items-center gap-2">
                {QUANTITIES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuantity(q)}
                    className={cn(
                      "h-9 rounded-lg border px-4 text-sm font-medium transition-colors cursor-pointer",
                      quantity === q
                        ? "border-primary bg-primary-soft text-primary-soft-fg"
                        : "border-border bg-surface text-muted-foreground hover:border-border-strong"
                    )}
                  >
                    {q}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setQuantity(-1)}
                  className={cn(
                    "h-9 rounded-lg border px-4 text-sm font-medium transition-colors cursor-pointer",
                    quantity === -1
                      ? "border-primary bg-primary-soft text-primary-soft-fg"
                      : "border-border bg-surface text-muted-foreground hover:border-border-strong"
                  )}
                >
                  Personalizado
                </button>
                {quantity === -1 && (
                  <Input
                    type="number"
                    min={1}
                    max={MAX_QUANTITY}
                    value={customQty}
                    onChange={(e) => setCustomQty(e.target.value)}
                    className="w-24"
                    placeholder="Qtd."
                  />
                )}
              </div>
            </div>
            {quantity > 60 && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Acima de 60 o sistema combina variações da busca (ex.: “imobiliária”,
                “corretora de imóveis”, “administradora de imóveis”) para somar empresas
                diferentes. Leva mais tempo e consome mais chamadas da sua cota do Google.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Características desejadas</CardTitle>
            <CardDescription>Refine o perfil das empresas que valem seu tempo.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {CHARACTERISTICS.map((c) => (
                <label
                  key={c.key}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:border-border-strong has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary-soft/40"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={Boolean(filters[c.key])}
                    onCheckedChange={(v) =>
                      setFilters((f) => ({ ...f, [c.key]: v === true }))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px]">{c.label}</span>
                    <span className="block text-[11px] leading-tight text-muted-foreground">{c.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {avisosDeFiltro.length > 0 && (
              <div className="mt-3 space-y-1.5" role="status">
                {avisosDeFiltro.map((aviso, i) => (
                  <p key={i} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {aviso}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        <Button size="lg" className="w-full sm:w-auto" onClick={submit} disabled={starting}>
          {starting ? <Loader2 className="animate-spin" /> : <Search />}
          Encontrar oportunidades
        </Button>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Como funciona</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-[13px] text-muted-foreground">
            {[
              "Buscamos empresas reais na fonte configurada",
              "Enriquecemos com telefone, Instagram, site e avaliações",
              "Removemos duplicados automaticamente",
              "A IA analisa cada negócio e identifica um problema concreto",
              "Cada lead recebe um score explicável de 0 a 100",
            ].map((s, i) => (
              <div key={i} className="flex gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary-soft-fg">
                  {i + 1}
                </span>
                {s}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            {/* Deixa explícito de onde vêm as empresas: o texto anterior
                mandava configurar o Google mesmo quando já estava ligado. */}
            {isLive ? (
              <>
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <MapPin className="size-3.5 text-primary" /> Conectado ao Google Maps
                </span>
                <br />
                As empresas vêm do Google Places — dados reais, com telefone, site e avaliações
                do perfil de cada negócio.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Fonte ativa:</span> {providerName}{" "}
                (demonstração). Conecte o Google Places em{" "}
                <Link href="/integracoes" className="text-primary hover:underline">
                  Integrações
                </Link>{" "}
                para buscar empresas reais do Google Maps.
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tela de processamento — progresso real dos jobs                     */
/* ------------------------------------------------------------------ */

function StepRow({ step }: { step: JobStep }) {
  const pct = step.total > 0 ? (step.done / step.total) * 100 : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          {step.status === "completed" ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : step.status === "processing" ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : step.status === "failed" ? (
            <XCircle className="size-4 text-danger" />
          ) : (
            <Circle className="size-4 text-border-strong" />
          )}
          <span className={cn(step.status === "queued" && "text-muted-foreground")}>
            {step.label}
          </span>
        </span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {step.total > 0 ? `${step.done}/${step.total}` : "—"}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

function JobProgress({
  job,
  lost,
  onNewSearch,
  onSeeLeads,
}: {
  job: ProspectingJob;
  lost: boolean;
  onNewSearch: () => void;
  onSeeLeads: () => void;
}) {
  // `lost` cobre o caso em que o job deixou de responder: os botões de saída
  // precisam aparecer mesmo sem um status terminal, senão a única saída é
  // recarregar a página.
  const finished = lost || job.status === "completed" || job.status === "failed";

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Compass className="size-4 text-primary" />
            {job.status === "completed"
              ? "Busca concluída"
              : job.status === "failed"
                ? "A busca encontrou um problema"
                : lost
                  ? "Perdemos o acompanhamento desta busca"
                  : `Prospectando ${job.params.niche} em ${job.params.city}…`}
          </CardTitle>
          <CardDescription>
            {job.params.quantity} empresas solicitadas · {job.params.city}, {job.params.country}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {job.steps.map((s) => (
            <StepRow key={s.key} step={s} />
          ))}

          {lost && job.status !== "completed" && job.status !== "failed" && (
            <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
              A busca continua rodando no servidor, mas paramos de receber o progresso. Os
              leads já encontrados estão salvos — confira a lista de leads.
            </div>
          )}

          {job.errors.length > 0 && (
            <div className="space-y-1 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3">
              {job.errors.slice(0, 4).map((e, i) => (
                <p key={i} className="text-[13px] text-warning">
                  {e}
                </p>
              ))}
            </div>
          )}

          {job.status === "completed" && (
            // Zero leads não é sucesso: com o mesmo visual verde de "deu
            // certo", a pessoa ia para a lista de leads e concluía que o
            // sistema tinha ignorado os filtros.
            <div
              className={
                job.found_lead_ids.length === 0
                  ? "rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning"
                  : "rounded-lg bg-primary-soft px-4 py-3 text-sm text-primary-soft-fg"
              }
            >
              {job.found_lead_ids.length === 0 ? (
                <span className="font-semibold">Nenhum lead foi salvo nesta busca.</span>
              ) : (
                <>
                  <span className="font-semibold">{job.found_lead_ids.length} novos leads</span> salvos,
                  analisados e pontuados.
                </>
              )}
              {job.duplicates > 0 && ` ${job.duplicates} duplicados foram ignorados.`}
              {(job.filtered ?? 0) > 0 &&
                ` ${job.filtered} empresas fora do perfil escolhido foram descartadas.`}
              {job.found_lead_ids.length < job.params.quantity &&
                job.status === "completed" &&
                // Distingue "acabaram as empresas novas aqui" de "os filtros
                // são restritivos demais" — a saída para cada caso é outra.
                ((job.filtered ?? 0) > job.duplicates
                  ? " Faltou completar o pedido porque muitas empresas não passaram nos filtros."
                  : ` Já prospectamos praticamente todas as empresas de ${job.params.niche} em ${job.params.city}. Tente outra cidade ou outro nicho.`)}

              {/* Qual critério derrubou quantas: com vários filtros marcados,
                  "afrouxe algum" não diz qual. */}
              {job.filtered_by && Object.keys(job.filtered_by).length > 0 && (
                <div className="mt-2.5 border-t border-primary/20 pt-2.5">
                  <p className="text-[12px] font-medium">Descartes por critério:</p>
                  <ul className="mt-1 space-y-0.5">
                    {Object.entries(job.filtered_by)
                      .sort((a, b) => b[1] - a[1])
                      .map(([chave, n]) => (
                        <li key={chave} className="text-[12px]">
                          {FILTER_LABEL[chave] ?? chave}: <span className="font-semibold tabular-nums">{n}</span> empresa(s)
                        </li>
                      ))}
                  </ul>
                  <p className="mt-1.5 text-[12px]">
                    Desmarque o critério do topo da lista para a próxima busca render mais.
                  </p>
                </div>
              )}
            </div>
          )}

          {finished && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={onSeeLeads}>
                Ver leads encontrados <ArrowRight />
              </Button>
              <Button variant="secondary" onClick={onNewSearch}>
                Nova busca
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
