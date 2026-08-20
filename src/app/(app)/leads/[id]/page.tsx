import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  AtSign,
  Building2,
  CheckCircle2,
  Clock,
  Globe,
  Lightbulb,
  Mail,
  MapPin,
  Phone,
  Sparkles,
  Star,
  TrendingUp,
} from "lucide-react";
import { getDb } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScoreBadge } from "@/components/score-badge";
import { LeadHeaderActions } from "@/features/leads/lead-actions";
import { MessageGenerator } from "@/features/leads/message-generator";
import { NotesPanel } from "@/features/leads/notes-panel";
import { buildNextAction } from "@/features/leads/next-action";
import { STATUS_LABEL } from "@/services/stats";
import { temperatureLabel } from "@/services/scoring";
import { formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Lead" };
export const dynamic = "force-dynamic";

const ACTIVITY_DOT: Record<string, string> = {
  lead_criado: "bg-info",
  lead_analisado: "bg-primary",
  score_atualizado: "bg-primary",
  mensagem_gerada: "bg-info",
  primeiro_contato: "bg-warning",
  mensagem_enviada: "bg-warning",
  resposta_recebida: "bg-score-hot",
  follow_up: "bg-warning",
  reuniao: "bg-score-hot",
  proposta_enviada: "bg-info",
  fechamento: "bg-primary",
  perda: "bg-danger",
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const lead = db.leads.find((l) => l.id === id);
  if (!lead) notFound();

  const analysis = db.lead_analysis.find((a) => a.lead_id === id);
  const scoreHistory = db.lead_score_history
    .filter((s) => s.lead_id === id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latestScore = scoreHistory[0];
  const activities = db.activities
    .filter((a) => a.lead_id === id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const notes = db.notes.filter((n) => n.lead_id === id);
  const generations = db.ai_generations
    .filter((g) => g.lead_id === id && g.saved)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const nextAction = buildNextAction(lead, db.tasks, analysis);
  const campaign = db.campaigns.find((c) => c.id === lead.campaign_id);

  return (
    <div className="space-y-5">
      <Link
        href="/leads"
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Voltar para Leads
      </Link>

      {/* Cabeçalho */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-4">
            <ScoreBadge score={lead.lead_score} size="lg" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{lead.company_name}</h1>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
                <span>{lead.segment}</span>
                <span className="text-border-strong">·</span>
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" /> {lead.city}
                  {lead.state ? `, ${lead.state}` : ""} — {lead.country}
                </span>
                {campaign && (
                  <>
                    <span className="text-border-strong">·</span>
                    <Link href={`/campanhas/${campaign.id}`} className="text-primary hover:underline">
                      {campaign.name}
                    </Link>
                  </>
                )}
              </p>
            </div>
          </div>
          <Badge variant="neutral" className="h-6">
            {STATUS_LABEL[lead.status]}
          </Badge>
        </div>
        <LeadHeaderActions lead={lead} users={db.users} />
      </div>

      <Tabs defaultValue="resumo">
        <TabsList>
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="mensagens">Abordagens IA</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notas">Notas {notes.length > 0 && `(${notes.length})`}</TabsTrigger>
        </TabsList>

        {/* ---------------- RESUMO ---------------- */}
        <TabsContent value="resumo">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="space-y-5 lg:col-span-2">
              {/* Próxima melhor ação */}
              {nextAction && (
                <Card className="border-primary/30 bg-primary-soft/30">
                  <CardContent className="flex items-center gap-3 p-4">
                    <TrendingUp className="size-4 shrink-0 text-primary" />
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-primary-soft-fg">
                        Próxima melhor ação
                      </p>
                      <p className="text-sm font-medium">{nextAction}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Análise IA */}
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" /> Análise da oportunidade
                  </CardTitle>
                  {analysis && (
                    <span className="text-xs text-muted-foreground">
                      Confiança: <span className="font-semibold text-foreground">{analysis.confidence}%</span>
                    </span>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  {!analysis ? (
                    <p className="py-4 text-[13px] text-muted-foreground">
                      Este lead ainda não foi analisado. Use o botão{" "}
                      <span className="font-medium text-foreground">Analisar oportunidade</span> no
                      topo para a IA identificar o problema comercial e calcular o potencial.
                    </p>
                  ) : (
                    <>
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-faint-foreground">
                          Presença digital
                        </p>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                          {analysis.digital_presence_summary}
                        </p>
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-faint-foreground">
                          O que a empresa já faz bem
                        </p>
                        <ul className="space-y-1">
                          {analysis.strengths.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" /> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="rounded-lg border border-score-hot/20 bg-score-hot-soft/50 p-4">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-score-hot">
                          Problema comercial identificado
                        </p>
                        <p className="text-sm leading-relaxed">{analysis.main_problem}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-faint-foreground">
                          Impacto potencial
                        </p>
                        <p className="text-[13px] leading-relaxed text-muted-foreground">
                          {analysis.problem_impact}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-faint-foreground">
                          <Lightbulb className="size-3.5" /> Solução recomendada:
                        </span>
                        <Badge>{analysis.recommended_solution}</Badge>
                      </div>
                      <p className="text-[11px] text-faint-foreground">
                        Analisado {timeAgo(analysis.created_at)} · modelo {analysis.model}
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Por que esse score? */}
              {latestScore && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      Por que esse lead recebeu {latestScore.score} pontos?
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1.5">
                      {latestScore.factors.map((f, i) => (
                        <div key={i} className="flex items-center justify-between text-[13px]">
                          <span className="text-muted-foreground">{f.label}</span>
                          <span
                            className={cn(
                              "font-semibold tabular-nums",
                              f.points > 0 ? "text-primary" : f.points < 0 ? "text-danger" : "text-muted-foreground"
                            )}
                          >
                            {f.points > 0 ? `+${f.points}` : f.points}
                          </span>
                        </div>
                      ))}
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
                        <span>Total — {temperatureLabel(latestScore.classification)}</span>
                        <span className="tabular-nums">{latestScore.score}/100</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Coluna lateral: dados */}
            <div className="space-y-5">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="size-4 text-muted-foreground" /> Dados
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2.5 text-[13px]">
                  <DataRow icon={Phone} label="Telefone" value={lead.phone} />
                  <DataRow icon={Phone} label="WhatsApp" value={lead.whatsapp} />
                  <DataRow icon={Mail} label="E-mail" value={lead.email} />
                  <DataRow
                    icon={Globe}
                    label="Site"
                    value={lead.website ?? "Não possui"}
                    href={lead.website ?? undefined}
                    muted={!lead.website}
                  />
                  <DataRow
                    icon={AtSign}
                    label="Instagram"
                    value={lead.instagram}
                    href={lead.instagram ? `https://instagram.com/${lead.instagram.replace("@", "")}` : undefined}
                  />
                  <DataRow icon={MapPin} label="Endereço" value={lead.address} />
                  <DataRow icon={Clock} label="Horário" value={lead.opening_hours} />
                  {(lead.reviews_count ?? 0) > 0 && (
                    <DataRow
                      icon={Star}
                      label="Avaliações"
                      value={`${lead.rating} (${lead.reviews_count} no Google)`}
                    />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Contexto</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2.5 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Origem</span>
                    <span className="font-medium">{lead.source === "demo" ? "Demonstração" : lead.source}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Descoberto</span>
                    <span className="font-medium">{timeAgo(lead.created_at)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Último contato</span>
                    <span className="font-medium">
                      {lead.last_contact_at ? timeAgo(lead.last_contact_at) : "Nunca"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Responsável</span>
                    <span className="font-medium">
                      {db.users.find((u) => u.id === lead.assigned_to)?.name ?? "—"}
                    </span>
                  </div>
                  {lead.description && (
                    <p className="border-t border-border pt-2.5 leading-relaxed text-muted-foreground">
                      {lead.description}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ---------------- MENSAGENS ---------------- */}
        <TabsContent value="mensagens">
          <MessageGenerator leadId={lead.id} hasAnalysis={Boolean(analysis)} savedGenerations={generations} />
        </TabsContent>

        {/* ---------------- TIMELINE ---------------- */}
        <TabsContent value="timeline">
          <Card>
            <CardContent className="p-5">
              {activities.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-muted-foreground">
                  Nenhuma atividade registrada ainda.
                </p>
              ) : (
                <div className="relative space-y-0 pl-1">
                  {activities.map((act, i) => {
                    const user = db.users.find((u) => u.id === act.user_id);
                    return (
                      <div key={act.id} className="relative flex gap-3.5 pb-5 last:pb-0">
                        {i < activities.length - 1 && (
                          <span className="absolute left-[5px] top-4 h-full w-px bg-border" />
                        )}
                        <span
                          className={cn(
                            "relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-surface",
                            ACTIVITY_DOT[act.type] ?? "bg-border-strong"
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px]">{act.description}</p>
                          <p className="mt-0.5 text-xs text-faint-foreground">
                            {formatDateTime(act.created_at)}
                            {user ? ` · ${user.name}` : " · Sistema"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- NOTAS ---------------- */}
        <TabsContent value="notas">
          <Card>
            <CardContent className="p-5">
              <NotesPanel leadId={lead.id} notes={notes} users={db.users} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DataRow({
  icon: Icon,
  label,
  value,
  href,
  muted,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  href?: string;
  muted?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-faint-foreground" />
      <div className="min-w-0 flex-1">
        <span className="block text-[11px] text-faint-foreground">{label}</span>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-primary hover:underline"
          >
            {value}
          </a>
        ) : (
          <span className={cn("block truncate font-medium", muted && "font-normal text-muted-foreground")}>
            {value}
          </span>
        )}
      </div>
    </div>
  );
}
