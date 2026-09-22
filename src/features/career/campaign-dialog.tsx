"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { previewCampaignAction, startCampaign } from "@/actions/career";
import type { CampaignInput, CampaignPreview, CareerSnapshot } from "@/services/career/service";
import type { ApplicationChannel } from "@/types/career";
import { TagInput } from "@/features/career/shared";

/**
 * Configuração e revisão da campanha. A ativação é a autorização dos envios
 * dentro dos parâmetros escolhidos — sem confirmação repetida por vaga.
 */
export function CampaignDialog({ open, onOpenChange, data, jobIds, recurringDefault = false }: { open: boolean; onOpenChange: (o: boolean) => void; data: CareerSnapshot; jobIds: string[]; recurringDefault?: boolean }) {
  const { toast } = useToast();
  const router = useRouter();
  const usable = data.resumes.filter((r) => ["ok", "parcial"].includes(r.text_status));
  const gmailReady = data.config.gmail.connection?.status === "ativa";
  const resendReady = data.config.resend.configured;
  const defaultChannel: ApplicationChannel = resendReady ? "resend" : gmailReady ? "gmail" : "manual";

  const [form, setForm] = React.useState<CampaignInput>({
    name: "",
    job_ids: jobIds,
    recurring: recurringDefault,
    roles: data.preferences.desired_roles,
    min_score: data.preferences.min_match_score,
    resume_version_id: data.profile?.resume_version_id && usable.some((r) => r.id === data.profile!.resume_version_id) ? data.profile.resume_version_id : usable[0]?.id ?? "",
    channel: defaultChannel,
    daily_limit: 10,
    ends_at: null,
    template_subject: data.defaultTemplates.subject,
    template_body: data.defaultTemplates.body,
  });
  const [step, setStep] = React.useState<"config" | "review">("config");
  const [preview, setPreview] = React.useState<{ previews: CampaignPreview[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = <K extends keyof CampaignInput>(k: K, v: CampaignInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function review() {
    setBusy(true);
    const res = await previewCampaignAction(form);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    setPreview({ previews: res.previews, warnings: res.warnings });
    setStep("review");
  }

  async function activate() {
    setBusy(true);
    const res = await startCampaign(form);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Campanha ativada. Acompanhe em “Minhas candidaturas”.");
    onOpenChange(false);
    router.refresh();
  }

  const channelNote =
    form.channel === "resend"
      ? resendReady
        ? "Envio pelo Resend com remetente do domínio verificado; seu e-mail das preferências vai como reply-to."
        : `Resend indisponível: ${data.config.resend.problem}`
      : form.channel === "gmail"
        ? gmailReady
          ? `Envio pela conta ${data.config.gmail.connection?.email}.`
          : "Conecte uma conta Gmail em “Minhas candidaturas” antes."
        : "Nenhum e-mail será enviado: o sistema prepara link, currículo e mensagem para você enviar manualmente.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step === "config" ? "Configurar campanha" : "Revisar antes de ativar"}</DialogTitle>
          <DialogDescription>
            {step === "config"
              ? `${jobIds.length} vaga(s) selecionada(s). Ativar autoriza os envios dentro destes parâmetros.`
              : "Confira o resumo e os exemplos de mensagem. Alterações depois exigem nova campanha."}
          </DialogDescription>
        </DialogHeader>

        {!data.profile?.confirmed && (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-[13px] text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Confirme o perfil extraído (aba “Meu currículo”) antes de ativar: as mensagens só usam dados confirmados.
          </p>
        )}

        {step === "config" ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="c-name">Nome</Label>
                <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Front-end remoto — setembro" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-resume">Versão do currículo</Label>
                <Select value={form.resume_version_id} onValueChange={(v) => set("resume_version_id", v)}>
                  <SelectTrigger id="c-resume"><SelectValue placeholder="Escolha" /></SelectTrigger>
                  <SelectContent>{usable.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-channel">Canal</Label>
                <Select value={form.channel} onValueChange={(v) => set("channel", v as ApplicationChannel)}>
                  <SelectTrigger id="c-channel"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="resend">Resend {resendReady ? "" : "(não configurado)"}</SelectItem>
                    <SelectItem value="gmail">Gmail {gmailReady ? `(${data.config.gmail.connection?.email})` : "(não conectado)"}</SelectItem>
                    <SelectItem value="manual">Apenas preparar (envio manual)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{channelNote}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-limit">Limite diário de envios</Label>
                <Input id="c-limit" type="number" min={1} max={200} value={form.daily_limit} onChange={(e) => set("daily_limit", Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-ends">Encerrar em (opcional)</Label>
                <Input id="c-ends" type="date" value={form.ends_at?.slice(0, 10) ?? ""} onChange={(e) => set("ends_at", e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-min">Nota mínima (campanha recorrente)</Label>
                <Input id="c-min" type="number" min={0} max={100} value={form.min_score} onChange={(e) => set("min_score", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
              </div>
            </div>
            <label className="flex items-start gap-2 text-[13px] cursor-pointer">
              <Checkbox className="mt-0.5" checked={form.recurring} onCheckedChange={(c) => set("recurring", Boolean(c))} />
              <span>
                <span className="font-medium">Campanha recorrente</span> — a cada 6 h busca vagas novas nas fontes configuradas e se candidata às que atingirem a nota mínima, até o limite diário, com o navegador fechado (depende do worker agendado).
              </span>
            </label>
            {form.recurring && (
              <div className="space-y-1.5">
                <Label htmlFor="c-roles">Cargos da busca recorrente</Label>
                <TagInput id="c-roles" value={form.roles} onChange={(v) => set("roles", v)} placeholder="Ex.: Analista de dados" max={10} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="c-subj">Assunto (modelo)</Label>
              <Input id="c-subj" value={form.template_subject} onChange={(e) => set("template_subject", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-body">Mensagem (modelo)</Label>
              <Textarea id="c-body" rows={10} value={form.template_body} onChange={(e) => set("template_body", e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">
                Placeholders: nome, email, telefone_opcional, empresa, cargo, fonte, competencia_relevante, responsabilidade_da_vaga, experiencia_ou_projeto_real, atividade_comprovada, resultado_documentado, segunda_competencia_confirmada, portfolio_ou_perfil, link_verificado. Frases sem dado real são omitidas.
                {data.config.llm ? " Com o modelo de linguagem ativo, o texto é reescrito naturalmente a partir destes dados." : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 rounded-lg bg-surface-hover p-3 text-[13px] sm:grid-cols-2">
              <p><span className="text-muted-foreground">Vagas:</span> {form.job_ids.length}{form.recurring ? " + recorrente" : ""}</p>
              <p><span className="text-muted-foreground">Canal:</span> {form.channel}</p>
              <p><span className="text-muted-foreground">Limite diário:</span> {form.daily_limit}</p>
              <p><span className="text-muted-foreground">Currículo:</span> {usable.find((r) => r.id === form.resume_version_id)?.label}</p>
            </div>
            {preview?.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-2 rounded-lg bg-warning-soft p-2.5 text-[13px] text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>
            ))}
            <div className="space-y-3">
              {preview?.previews.map((p) => (
                <div key={p.job.id} className="rounded-lg border border-border p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{p.job.title}</span>
                    <span className="text-muted-foreground">· {p.job.company}</span>
                    <Badge variant={p.channel === "manual" ? "warning" : "info"}>{p.channel === "manual" ? "ação manual" : `${p.channel} → ${p.recipient}`}</Badge>
                    {p.match && <Badge variant="neutral">aderência {p.match.score}</Badge>}
                  </div>
                  {p.note && <p className="mt-1 text-xs text-warning">{p.note}</p>}
                  <p className="mt-2 text-xs font-medium">Assunto: {p.subject}</p>
                  <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-hover p-2 font-sans text-xs">{p.body_text}</pre>
                  <p className="mt-1 text-[11px] text-faint-foreground">Anexo: PDF da versão escolhida. Exemplo gerado pelo modelo determinístico; com IA ativa o texto final é reescrito com os mesmos dados.</p>
                </div>
              ))}
              {form.job_ids.length > 5 && <p className="text-xs text-muted-foreground">Mostrando 5 de {form.job_ids.length} exemplos.</p>}
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "config" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button disabled={busy || !form.resume_version_id || (!form.recurring && form.job_ids.length === 0)} onClick={review}>
                {busy ? <Loader2 className="animate-spin" /> : null} Revisar campanha
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep("config")}>Voltar</Button>
              <Button disabled={busy || !data.profile?.confirmed} onClick={activate}>
                {busy ? <Loader2 className="animate-spin" /> : <Send />} Ativar e autorizar envios
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
