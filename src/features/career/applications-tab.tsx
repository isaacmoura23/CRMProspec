"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, ExternalLink, Inbox, Loader2, Mail, Pause, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/empty-state";
import { changeCampaignStatus, completeManual, disconnectGmail, eraseCareerData, exportApplicationsCsv, getResumeUrl, retrySend, setSelection } from "@/actions/career";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { CareerSnapshot } from "@/services/career/service";
import type { ApplicationCampaign, JobApplication, ProcessingStatus, SelectionStatus } from "@/types/career";
import { CampaignDialog } from "@/features/career/campaign-dialog";
import { EMAIL_LABEL, EMAIL_VARIANT, JobProgressList, PROCESSING_LABEL, PROCESSING_VARIANT, SELECTION_LABEL, Stat } from "@/features/career/shared";

export function ApplicationsTab({ data, gmailNotice }: { data: CareerSnapshot; gmailNotice: { status: string; reason: string | null } | null }) {
  const { toast } = useToast();
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<ProcessingStatus | "todas">("todas");
  const [selected, setSelected] = React.useState<JobApplication | null>(null);
  const [recurringOpen, setRecurringOpen] = React.useState(false);

  React.useEffect(() => {
    if (!gmailNotice) return;
    if (gmailNotice.status === "ok") toast("Conta Gmail conectada.");
    else toast(`Falha ao conectar o Gmail: ${gmailNotice.reason ?? "erro"}`, "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailNotice?.status]);

  const apps = data.applications.filter((a) => {
    if (status !== "todas" && a.processing_status !== status) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!`${a.job_snapshot.title} ${a.job_snapshot.company} ${a.recipient ?? ""}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totals = {
    total: data.applications.length,
    sent: data.applications.filter((a) => a.processing_status === "concluida" && a.channel !== "manual").length,
    manual: data.applications.filter((a) => a.processing_status === "acao_manual").length,
    delivered: data.applications.filter((a) => a.email_status === "entregue").length,
    responded: data.applications.filter((a) => !["registrada"].includes(a.selection_status)).length,
    problems: data.applications.filter((a) => ["falhou", "resultado_incerto"].includes(a.processing_status) || a.email_status === "devolvido" || a.email_status === "reclamacao").length,
  };

  async function exportCsv() {
    const csv = await exportApplicationsCsv();
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `candidaturas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Candidaturas" value={totals.total} hint="retries não contam como novas" />
        <Stat label="Enviadas" value={totals.sent} hint="aceitas pelo provedor" />
        <Stat label="Entregues" value={totals.delivered} hint="confirmadas por webhook" />
        <Stat label="Ação manual" value={totals.manual} />
        <Stat label="Com retorno" value={totals.responded} hint="status atualizado à mão" />
        <Stat label="Problemas" value={totals.problems} />
      </div>

      <CampaignsCard campaigns={data.campaigns} data={data} onRecurring={() => setRecurringOpen(true)} />

      <JobProgressList jobs={data.activeJobs} kinds={["campaign_tick", "send_application"]} />

      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle>Histórico</CardTitle>
            <CardDescription>Processamento, e-mail e processo seletivo são estados independentes.</CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="ap-q" className="sr-only">Buscar</Label>
              <Input id="ap-q" placeholder="Empresa, vaga ou destino" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
            </div>
            <div className="w-48">
              <Select value={status} onValueChange={(v) => setStatus(v as ProcessingStatus | "todas")}>
                <SelectTrigger aria-label="Filtrar por processamento"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">Todos os estados</SelectItem>
                  {(Object.keys(PROCESSING_LABEL) as ProcessingStatus[]).map((k) => <SelectItem key={k} value={k}>{PROCESSING_LABEL[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={data.applications.length === 0}><Download /> CSV</Button>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {apps.length === 0 ? (
            <EmptyState icon={Inbox} title="Nenhuma candidatura" description="Selecione vagas em “Vagas compatíveis” e inicie uma campanha." className="m-5 mt-0" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Empresa / vaga</TableHead>
                    <TableHead>Aderência</TableHead>
                    <TableHead>Canal / destino</TableHead>
                    <TableHead>Processamento</TableHead>
                    <TableHead>E-mail</TableHead>
                    <TableHead>Seleção</TableHead>
                    <TableHead>Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apps.map((a) => (
                    <TableRow key={a.id} className="cursor-pointer" onClick={() => setSelected(a)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(a)}>
                      <TableCell>
                        <p className="font-medium">{a.job_snapshot.company}</p>
                        <p className="text-xs text-muted-foreground">{a.job_snapshot.title}</p>
                      </TableCell>
                      <TableCell className="tabular-nums">{a.match_score ?? "—"}</TableCell>
                      <TableCell>
                        <p className="text-xs">{a.channel}</p>
                        <p className="max-w-40 truncate text-xs text-muted-foreground">{a.recipient ?? a.manual_apply_url ?? "—"}</p>
                      </TableCell>
                      <TableCell><Badge variant={PROCESSING_VARIANT[a.processing_status]}>{PROCESSING_LABEL[a.processing_status]}</Badge></TableCell>
                      <TableCell>{a.email_status ? <Badge variant={EMAIL_VARIANT[a.email_status]}>{EMAIL_LABEL[a.email_status]}</Badge> : <span className="text-xs text-faint-foreground">—</span>}</TableCell>
                      <TableCell className="text-xs">{SELECTION_LABEL[a.selection_status]}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.sent_at ? formatDateTime(a.sent_at) : timeAgo(a.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <GmailCard data={data} />
        <DangerCard />
      </div>

      {selected && <ApplicationDialog app={data.applications.find((a) => a.id === selected.id) ?? selected} data={data} onClose={() => setSelected(null)} />}
      {recurringOpen && data.profile && <CampaignDialog open={recurringOpen} onOpenChange={setRecurringOpen} data={data} jobIds={[]} recurringDefault />}
    </div>
  );
}

function CampaignsCard({ campaigns, data, onRecurring }: { campaigns: ApplicationCampaign[]; data: CareerSnapshot; onRecurring: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  async function change(id: string, status: "ativa" | "pausada" | "cancelada") {
    if (status === "cancelada" && !confirm("Cancelar a campanha? Candidaturas ainda não enviadas serão canceladas; as enviadas permanecem.")) return;
    setBusy(id);
    const res = await changeCampaignStatus(id, status);
    setBusy(null);
    if (!res.ok) return toast(res.error, "error");
    router.refresh();
  }
  const active = campaigns.filter((c) => c.status === "ativa" || c.status === "pausada");
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Campanhas</CardTitle>
          <CardDescription>Pausar ou cancelar impede novos envios já enfileirados; o estado é conferido antes de cada chamada externa.</CardDescription>
        </div>
        <Button size="sm" variant="secondary" disabled={!data.profile?.confirmed} onClick={onRecurring}><RefreshCw /> Nova campanha recorrente</Button>
      </CardHeader>
      <CardContent>
        {campaigns.length === 0 ? <p className="text-[13px] text-muted-foreground">Nenhuma campanha ainda.</p> : (
          <ul className="divide-y divide-border">
            {[...active, ...campaigns.filter((c) => !active.includes(c))].slice(0, 8).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{c.name} <Badge variant={c.status === "ativa" ? "good" : c.status === "pausada" ? "warning" : "neutral"} className="ml-1">{c.status}</Badge>{c.recurring && <Badge variant="info" className="ml-1">recorrente</Badge>}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.job_ids.length} vaga(s) · canal {c.channel} · {c.sent_today}/{c.daily_limit} hoje
                    {c.recurring && c.next_run_at && c.status === "ativa" ? ` · próxima execução ${formatDateTime(c.next_run_at)}` : ""}
                    {c.last_run_at ? ` · última ${timeAgo(c.last_run_at)}` : ""}
                  </p>
                </div>
                {c.status === "ativa" && <Button size="xs" variant="secondary" disabled={busy === c.id} onClick={() => change(c.id, "pausada")}><Pause /> Pausar</Button>}
                {c.status === "pausada" && <Button size="xs" variant="secondary" disabled={busy === c.id} onClick={() => change(c.id, "ativa")}><Play /> Retomar</Button>}
                {(c.status === "ativa" || c.status === "pausada") && <Button size="xs" variant="danger-ghost" disabled={busy === c.id} onClick={() => change(c.id, "cancelada")}><Square /> Cancelar</Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ApplicationDialog({ app, data, onClose }: { app: JobApplication; data: CareerSnapshot; onClose: () => void }) {
  const { toast } = useToast();
  const router = useRouter();
  const events = data.events.filter((e) => e.application_id === app.id);
  const [sel, setSel] = React.useState<SelectionStatus>(app.selection_status);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function saveSelection() {
    setBusy(true);
    const res = await setSelection({ applicationId: app.id, status: sel, note: note || null });
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Status do processo seletivo atualizado (manual).");
    setNote("");
    router.refresh();
  }
  async function done() {
    setBusy(true);
    const res = await completeManual(app.id, note || null);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Candidatura marcada como concluída.");
    router.refresh();
  }
  async function retry() {
    setBusy(true);
    const res = await retrySend(app.id);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Reenvio enfileirado.");
    router.refresh();
  }
  async function openResume() {
    const res = await getResumeUrl(app.resume_version_id);
    if (!res.ok) return toast(res.error, "error");
    window.open(res.url, "_blank", "noopener");
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{app.job_snapshot.title} · {app.job_snapshot.company}</DialogTitle>
          <DialogDescription>
            <a href={app.job_snapshot.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">Anúncio <ExternalLink className="size-3" /></a>
            {" · "}canal {app.channel}{app.recipient ? ` → ${app.recipient}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant={PROCESSING_VARIANT[app.processing_status]}>{PROCESSING_LABEL[app.processing_status]}</Badge>
          {app.email_status && <Badge variant={EMAIL_VARIANT[app.email_status]}>{EMAIL_LABEL[app.email_status]}</Badge>}
          <Badge variant="neutral">{SELECTION_LABEL[app.selection_status]}</Badge>
          {app.provider_message_id && <Badge variant="outline">comprovante {app.provider_message_id.slice(0, 18)}…</Badge>}
        </div>
        {app.last_error && <p className="mt-2 text-[13px] text-danger">{app.last_error}</p>}

        {app.processing_status === "acao_manual" && (
          <div className="mt-3 rounded-lg bg-warning-soft p-3 text-[13px] text-warning">
            <p className="font-medium">Ação manual necessária</p>
            <p>O anúncio não publica e-mail de candidatura. Use o link da vaga, anexe o PDF e cole a mensagem abaixo. Abrir a página não conta como candidatura: marque como concluída depois de enviar.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="xs" asChild><a href={app.manual_apply_url ?? app.job_snapshot.url} target="_blank" rel="noopener noreferrer"><ExternalLink /> Abrir vaga</a></Button>
              <Button size="xs" variant="secondary" onClick={openResume}>Baixar currículo</Button>
              <Button size="xs" variant="secondary" onClick={() => navigator.clipboard.writeText(`${app.subject}\n\n${app.body_text}`).then(() => toast("Mensagem copiada."))}>Copiar mensagem</Button>
              <Button size="xs" variant="secondary" disabled={busy} onClick={done}>Marcar como concluída</Button>
            </div>
          </div>
        )}
        {["falhou", "resultado_incerto"].includes(app.processing_status) && (
          <div className="mt-3">
            <Button size="xs" variant="secondary" disabled={busy} onClick={retry}><RefreshCw /> Tentar novamente (mesma chave de idempotência)</Button>
          </div>
        )}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-faint-foreground">Mensagem enviada</p>
            <p className="mt-1 text-[13px] font-medium">{app.subject}</p>
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-hover p-2 font-sans text-xs">{app.body_text}</pre>
            <p className="mt-1 text-[11px] text-faint-foreground">Currículo: {data.resumes.find((r) => r.id === app.resume_version_id)?.label ?? app.resume_version_id} · tentativas: {app.attempts_count}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-faint-foreground">Linha do tempo</p>
            <ol className="mt-1 max-h-64 space-y-1.5 overflow-y-auto text-xs">
              {events.length === 0 && <li className="text-muted-foreground">Sem eventos.</li>}
              {events.map((e) => (
                <li key={e.id} className="rounded-md border border-border p-2">
                  <p className="font-medium">{e.type} <span className="font-normal text-faint-foreground">· {e.source}</span></p>
                  {e.detail && <p className="text-muted-foreground">{e.detail}</p>}
                  <p className="text-[11px] text-faint-foreground">{formatDateTime(e.occurred_at)}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="text-[13px] font-medium">Processo seletivo (atualização manual)</p>
          <p className="text-xs text-muted-foreground">Respostas não são sincronizadas automaticamente; registre aqui o que recebeu.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <Select value={sel} onValueChange={(v) => setSel(v as SelectionStatus)}>
              <SelectTrigger aria-label="Status de seleção"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(SELECTION_LABEL) as SelectionStatus[]).map((k) => <SelectItem key={k} value={k}>{SELECTION_LABEL[k]}</SelectItem>)}</SelectContent>
            </Select>
            <Textarea rows={1} placeholder="Observação (opcional)" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-9" />
            <Button size="sm" disabled={busy} onClick={saveSelection}>{busy ? <Loader2 className="animate-spin" /> : null} Salvar</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GmailCard({ data }: { data: CareerSnapshot }) {
  const { toast } = useToast();
  const router = useRouter();
  const g = data.config.gmail;
  const [busy, setBusy] = React.useState(false);
  async function disconnect() {
    setBusy(true);
    const res = await disconnectGmail();
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Conta Gmail desconectada e tokens revogados.");
    router.refresh();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Canais de envio</CardTitle>
        <CardDescription>Resend é o canal principal (domínio verificado). Gmail envia pela sua própria conta, com permissão mínima de envio.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-[13px]">
        <div className="flex items-start gap-2">
          <Mail className="mt-0.5 size-4 text-muted-foreground" />
          <div>
            <p className="font-medium">Resend <Badge variant={data.config.resend.configured ? "good" : "neutral"} className="ml-1">{data.config.resend.configured ? "pronto" : "não configurado"}</Badge></p>
            <p className="text-xs text-muted-foreground">{data.config.resend.problem ?? "RESEND_API_KEY, RESEND_FROM_EMAIL e RESEND_WEBHOOK_SECRET definidos no servidor."}</p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Mail className="mt-0.5 size-4 text-muted-foreground" />
          <div className="flex-1">
            <p className="font-medium">Gmail <Badge variant={g.connection?.status === "ativa" ? "good" : g.connection ? "danger" : "neutral"} className="ml-1">{g.connection ? `${g.connection.email} · ${g.connection.status}` : "não conectado"}</Badge></p>
            <p className="text-xs text-muted-foreground">{g.problem ?? "Escopo gmail.send; tokens cifrados no servidor. Respostas não são lidas — atualize o status de seleção manualmente."}</p>
            <div className="mt-2 flex gap-2">
              {g.oauthConfigured && (!g.connection || g.connection.status !== "ativa") && (
                <Button size="xs" asChild><a href="/api/career/gmail/connect">Conectar conta Gmail</a></Button>
              )}
              {g.connection && <Button size="xs" variant="danger-ghost" disabled={busy} onClick={disconnect}>Desconectar e revogar</Button>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DangerCard() {
  const { toast } = useToast();
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  async function erase() {
    setBusy(true);
    const res = await eraseCareerData(text);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Todos os dados de carreira foram excluídos.");
    setText("");
    router.refresh();
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Privacidade e exclusão</CardTitle>
        <CardDescription>
          Seus PDFs ficam em armazenamento privado e nunca vão para os webhooks comerciais do CRM. Provedores que processam o currículo: o parser local, o modelo de linguagem (se configurado), o OCR (se configurado) e o canal de e-mail escolhido no envio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[13px]">Excluir apaga perfil, versões, análises, vagas, campanhas e candidaturas; cancela jobs pendentes e revoga a conexão Gmail.</p>
        <div className="flex gap-2">
          <Input aria-label="Digite EXCLUIR para confirmar" placeholder="Digite EXCLUIR" value={text} onChange={(e) => setText(e.target.value)} className="max-w-48" />
          <Button variant="danger" disabled={busy || text !== "EXCLUIR"} onClick={erase}><Trash2 /> Excluir tudo</Button>
        </div>
      </CardContent>
    </Card>
  );
}
