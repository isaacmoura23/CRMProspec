"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileText, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/empty-state";
import { finalizeUpload, getResumeUrl, prepareUpload, reanalyze, removeResume, saveProfile, savePrefs } from "@/actions/career";
import { formatDateTime } from "@/lib/format";
import type { CareerSnapshot } from "@/services/career/service";
import type { CareerProfile, CareerPreferences, ResumeVersion, WorkMode } from "@/types/career";
import { JobProgressList, TagInput, formatBytes } from "@/features/career/shared";
import { cn } from "@/lib/utils";

const TEXT_STATUS: Record<ResumeVersion["text_status"], { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }> = {
  pendente: { label: "Aguardando arquivo", variant: "neutral" },
  ok: { label: "Texto extraído", variant: "good" },
  parcial: { label: "Extração parcial", variant: "warning" },
  sem_texto: { label: "Sem texto", variant: "danger" },
  ocr_pendente: { label: "OCR pendente", variant: "info" },
  ocr_indisponivel: { label: "OCR indisponível", variant: "warning" },
  protegido: { label: "Protegido por senha", variant: "danger" },
  corrompido: { label: "Não foi possível ler", variant: "danger" },
  paginas_excedidas: { label: "Páginas em excesso", variant: "danger" },
};

export function ResumeTab({ data }: { data: CareerSnapshot }) {
  const { toast } = useToast();
  const router = useRouter();
  const [dragging, setDragging] = React.useState(false);
  const [uploading, setUploading] = React.useState<{ name: string; step: string } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast("Envie um arquivo PDF.", "error");
      return;
    }
    if (file.size > data.config.maxPdfBytes) {
      toast(`O arquivo excede ${Math.round(data.config.maxPdfBytes / 1024 / 1024)} MB.`, "error");
      return;
    }
    setUploading({ name: file.name, step: "Preparando envio" });
    try {
      const prep = await prepareUpload({ fileName: file.name, sizeBytes: file.size });
      if (!prep.ok) throw new Error(prep.error);
      setUploading({ name: file.name, step: "Enviando arquivo" });
      let result: { duplicateOf: string | null; textStatus: string; textNote: string | null };
      if (prep.target.mode === "direct") {
        const put = await fetch(prep.target.url, {
          method: "PUT",
          headers: { "Content-Type": "application/pdf", Authorization: `Bearer ${prep.target.token}`, "x-upsert": "true" },
          body: file,
        });
        if (!put.ok) throw new Error(`O armazenamento recusou o arquivo (${put.status}).`);
        setUploading({ name: file.name, step: "Validando e extraindo texto" });
        const fin = await finalizeUpload(prep.versionId);
        if (!fin.ok) throw new Error(fin.error);
        result = fin;
      } else {
        const form = new FormData();
        form.append("versionId", prep.versionId);
        form.append("file", file);
        setUploading({ name: file.name, step: "Validando e extraindo texto" });
        const res = await fetch(prep.target.url, { method: "POST", body: form });
        const body = (await res.json()) as { error?: string; duplicateOf?: string | null; textStatus?: string; textNote?: string | null };
        if (!res.ok) throw new Error(body.error ?? `Falha no upload (${res.status})`);
        result = { duplicateOf: body.duplicateOf ?? null, textStatus: body.textStatus ?? "pendente", textNote: body.textNote ?? null };
      }
      if (result.duplicateOf) toast("Este PDF já estava enviado — a versão existente foi mantida.", "info");
      else if (["ok", "parcial", "ocr_pendente"].includes(result.textStatus)) toast("Currículo recebido. A análise começou.");
      else toast(result.textNote ?? "Currículo recebido, mas o texto não pôde ser lido.", "error");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Falha no envio.", "error");
    } finally {
      setUploading(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        {/* Upload */}
        <Card>
          <CardHeader>
            <CardTitle>Enviar currículo</CardTitle>
            <CardDescription>PDF de até {Math.round(data.config.maxPdfBytes / 1024 / 1024)} MB. O arquivo fica privado e só você acessa.</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              role="button"
              tabIndex={0}
              aria-label="Enviar currículo PDF: arraste o arquivo ou pressione Enter para escolher"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) upload(file);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                dragging ? "border-primary bg-primary-soft/40" : "border-border-strong bg-surface hover:bg-surface-hover"
              )}
            >
              {uploading ? (
                <>
                  <Loader2 className="mb-2 size-6 animate-spin text-primary" />
                  <p className="text-sm font-medium">{uploading.name}</p>
                  <p className="text-xs text-muted-foreground">{uploading.step}…</p>
                </>
              ) : (
                <>
                  <Upload className="mb-2 size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">Arraste o PDF aqui ou clique para escolher</p>
                  <p className="mt-1 text-xs text-muted-foreground">Texto selecionável é lido na hora; PDF digitalizado depende de OCR{data.config.ocr.configured ? " (configurado)" : " (não configurado)"}.</p>
                </>
              )}
              <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </div>
            <JobProgressList jobs={data.activeJobs} kinds={["analyze_resume", "check_links"]} />
          </CardContent>
        </Card>

        {/* Versões */}
        <Card>
          <CardHeader>
            <CardTitle>Versões</CardTitle>
            <CardDescription>O original é preservado; versões revisadas são geradas a partir das sugestões aceitas.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.resumes.length === 0 ? (
              <EmptyState icon={FileText} title="Nenhum currículo enviado" description="Envie um PDF para começar a análise." className="py-8" />
            ) : (
              <ul className="divide-y divide-border">
                {data.resumes.map((v) => (
                  <VersionRow key={v.id} version={v} isCurrent={data.profile?.resume_version_id === v.id} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        {data.profile ? <ProfileEditor key={data.profile.updated_at} profile={data.profile} /> : (
          <Card>
            <CardHeader>
              <CardTitle>Perfil profissional</CardTitle>
              <CardDescription>Extraído do currículo assim que o PDF for lido.</CardDescription>
            </CardHeader>
          </Card>
        )}
        <PreferencesEditor key={data.preferences.updated_at} prefs={data.preferences} hasProfile={Boolean(data.profile)} />
      </div>
    </div>
  );
}

function VersionRow({ version, isCurrent }: { version: ResumeVersion; isCurrent: boolean }) {
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const status = TEXT_STATUS[version.text_status];

  async function open() {
    const res = await getResumeUrl(version.id);
    if (!res.ok) return toast(res.error, "error");
    window.open(res.url, "_blank", "noopener");
  }
  async function remove() {
    if (!confirm(`Excluir "${version.label}"? Análises e links desta versão também serão removidos.`)) return;
    setBusy(true);
    const res = await removeResume(version.id);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Versão excluída.");
    router.refresh();
  }
  async function again() {
    setBusy(true);
    const res = await reanalyze(version.id);
    setBusy(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Nova análise enfileirada.");
    router.refresh();
  }

  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
        <FileText className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium">{version.label}</p>
          <Badge variant={version.kind === "revisada" ? "info" : "neutral"}>{version.kind === "revisada" ? "Revisada" : "Original"}</Badge>
          {isCurrent && <Badge variant="good">Perfil atual</Badge>}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDateTime(version.created_at)} · {formatBytes(version.size_bytes)}
          {version.page_count ? ` · ${version.page_count} pág.` : ""} · {version.links.length} link(s)
        </p>
        {version.text_note && <p className="mt-1 text-xs text-warning">{version.text_note}</p>}
      </div>
      <div className="flex gap-1">
        <Button size="xs" variant="ghost" onClick={open} aria-label="Abrir PDF">
          Abrir
        </Button>
        {["ok", "parcial", "ocr_pendente"].includes(version.text_status) && (
          <Button size="xs" variant="ghost" onClick={again} disabled={busy} aria-label="Reanalisar">
            <RefreshCw /> Reanalisar
          </Button>
        )}
        <Button size="xs" variant="danger-ghost" onClick={remove} disabled={busy} aria-label="Excluir versão">
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

/* ---------- Perfil ---------- */

function ProfileEditor({ profile }: { profile: CareerProfile }) {
  const { toast } = useToast();
  const router = useRouter();
  // O `key` no componente pai remonta o editor quando o perfil muda no servidor.
  const [form, setForm] = React.useState<CareerProfile>(profile);
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof CareerProfile>(k: K, v: CareerProfile[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save(confirmed: boolean) {
    setSaving(true);
    const res = await saveProfile({
      full_name: form.full_name,
      email: form.email || null,
      phone: form.phone || null,
      location: form.location || null,
      headline: form.headline || null,
      summary: form.summary || null,
      experiences: form.experiences,
      education: form.education,
      skills: form.skills,
      languages: form.languages,
      certifications: form.certifications,
      projects: form.projects,
      links: form.links,
      confirmed,
    });
    setSaving(false);
    if (!res.ok) return toast(res.error, "error");
    toast(confirmed ? "Perfil confirmado. Ele passa a alimentar as candidaturas." : "Perfil salvo.");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Perfil profissional</CardTitle>
          <CardDescription>Extraído do currículo ({profile.extraction_model}). Corrija o que estiver errado antes de se candidatar.</CardDescription>
        </div>
        {profile.confirmed ? (
          <Badge variant="good"><CheckCircle2 className="size-3" /> Confirmado</Badge>
        ) : (
          <Badge variant="warning"><AlertTriangle className="size-3" /> A revisar</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome" id="p-name"><Input id="p-name" value={form.full_name} onChange={(e) => set("full_name", e.target.value)} /></Field>
          <Field label="Cargo / título" id="p-head"><Input id="p-head" value={form.headline ?? ""} onChange={(e) => set("headline", e.target.value)} /></Field>
          <Field label="E-mail" id="p-email"><Input id="p-email" type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Telefone" id="p-phone"><Input id="p-phone" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Localização" id="p-loc" className="sm:col-span-2"><Input id="p-loc" value={form.location ?? ""} onChange={(e) => set("location", e.target.value)} /></Field>
        </div>
        <Field label="Resumo" id="p-sum"><Textarea id="p-sum" rows={3} value={form.summary ?? ""} onChange={(e) => set("summary", e.target.value)} /></Field>
        <Field label="Competências" id="p-skills"><TagInput id="p-skills" value={form.skills} onChange={(v) => set("skills", v)} placeholder="Ex.: React, SQL, negociação" max={80} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Idiomas" id="p-lang"><TagInput id="p-lang" value={form.languages} onChange={(v) => set("languages", v)} placeholder="Ex.: português, inglês" /></Field>
          <Field label="Certificações" id="p-cert"><TagInput id="p-cert" value={form.certifications} onChange={(v) => set("certifications", v)} placeholder="Ex.: AWS CCP" max={30} /></Field>
        </div>

        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Experiências ({form.experiences.length})</summary>
          <div className="space-y-3 border-t border-border p-3">
            {form.experiences.map((e, i) => (
              <div key={i} className="space-y-2 rounded-lg bg-surface-hover p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input aria-label="Cargo" placeholder="Cargo" value={e.role} onChange={(ev) => set("experiences", form.experiences.map((x, j) => (j === i ? { ...x, role: ev.target.value } : x)))} />
                  <Input aria-label="Empresa" placeholder="Empresa" value={e.company} onChange={(ev) => set("experiences", form.experiences.map((x, j) => (j === i ? { ...x, company: ev.target.value } : x)))} />
                  <Input aria-label="Início (AAAA-MM)" placeholder="Início (AAAA-MM)" value={e.start ?? ""} onChange={(ev) => set("experiences", form.experiences.map((x, j) => (j === i ? { ...x, start: ev.target.value || null } : x)))} />
                  <Input aria-label="Fim (AAAA-MM ou vazio = atual)" placeholder="Fim (vazio = atual)" value={e.end ?? ""} onChange={(ev) => set("experiences", form.experiences.map((x, j) => (j === i ? { ...x, end: ev.target.value || null } : x)))} />
                </div>
                <Textarea aria-label="Descrição" rows={3} value={e.description} onChange={(ev) => set("experiences", form.experiences.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{e.page ? `Página ${e.page}` : ""}</span>
                  <button type="button" className="text-danger hover:underline cursor-pointer" onClick={() => set("experiences", form.experiences.filter((_, j) => j !== i))}>Remover</button>
                </div>
              </div>
            ))}
            <Button size="xs" variant="secondary" onClick={() => set("experiences", [...form.experiences, { company: "", role: "", start: null, end: null, description: "", page: null }])}>Adicionar experiência</Button>
          </div>
        </details>

        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium">Formação ({form.education.length}) e projetos ({form.projects.length})</summary>
          <div className="space-y-3 border-t border-border p-3">
            {form.education.map((e, i) => (
              <div key={`edu-${i}`} className="grid gap-2 rounded-lg bg-surface-hover p-3 sm:grid-cols-2">
                <Input aria-label="Curso/grau" placeholder="Curso / grau" value={e.degree} onChange={(ev) => set("education", form.education.map((x, j) => (j === i ? { ...x, degree: ev.target.value } : x)))} />
                <Input aria-label="Instituição" placeholder="Instituição" value={e.institution} onChange={(ev) => set("education", form.education.map((x, j) => (j === i ? { ...x, institution: ev.target.value } : x)))} />
                <Input aria-label="Início" placeholder="Início" value={e.start ?? ""} onChange={(ev) => set("education", form.education.map((x, j) => (j === i ? { ...x, start: ev.target.value || null } : x)))} />
                <div className="flex gap-2">
                  <Input aria-label="Fim" placeholder="Fim" value={e.end ?? ""} onChange={(ev) => set("education", form.education.map((x, j) => (j === i ? { ...x, end: ev.target.value || null } : x)))} />
                  <Button size="icon-sm" variant="danger-ghost" aria-label="Remover formação" onClick={() => set("education", form.education.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              </div>
            ))}
            <Button size="xs" variant="secondary" onClick={() => set("education", [...form.education, { institution: "", degree: "", start: null, end: null, page: null }])}>Adicionar formação</Button>
            {form.projects.map((p, i) => (
              <div key={`prj-${i}`} className="grid gap-2 rounded-lg bg-surface-hover p-3">
                <Input aria-label="Nome do projeto" placeholder="Projeto" value={p.name} onChange={(ev) => set("projects", form.projects.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))} />
                <Textarea aria-label="Descrição do projeto" rows={2} value={p.description} onChange={(ev) => set("projects", form.projects.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)))} />
                <div className="flex gap-2">
                  <Input aria-label="URL do projeto" placeholder="https://" value={p.url ?? ""} onChange={(ev) => set("projects", form.projects.map((x, j) => (j === i ? { ...x, url: ev.target.value || null } : x)))} />
                  <Button size="icon-sm" variant="danger-ghost" aria-label="Remover projeto" onClick={() => set("projects", form.projects.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              </div>
            ))}
            <Button size="xs" variant="secondary" onClick={() => set("projects", [...form.projects, { name: "", description: "", url: null, page: null }])}>Adicionar projeto</Button>
          </div>
        </details>

        <Field label="Links" id="p-links"><TagInput id="p-links" value={form.links} onChange={(v) => set("links", v)} placeholder="https://" max={30} /></Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => save(profile.confirmed)}>Salvar</Button>
          <Button disabled={saving || !form.full_name.trim()} onClick={() => save(true)}>{saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Salvar e confirmar</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------- Preferências ---------- */

const WORK_MODES: Array<{ key: WorkMode; label: string }> = [
  { key: "remoto", label: "Remoto" },
  { key: "hibrido", label: "Híbrido" },
  { key: "presencial", label: "Presencial" },
];

function PreferencesEditor({ prefs, hasProfile }: { prefs: CareerPreferences; hasProfile: boolean }) {
  const { toast } = useToast();
  const router = useRouter();
  const [form, setForm] = React.useState(prefs);
  const [saving, setSaving] = React.useState(false);
  const set = <K extends keyof CareerPreferences>(k: K, v: CareerPreferences[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    const res = await savePrefs({
      desired_roles: form.desired_roles,
      locations: form.locations,
      work_modes: form.work_modes,
      languages: form.languages,
      contract_types: form.contract_types,
      min_salary: form.min_salary,
      currency: form.currency || "BRL",
      excluded_companies: form.excluded_companies,
      min_match_score: form.min_match_score,
      candidate_email: form.candidate_email || null,
    });
    setSaving(false);
    if (!res.ok) return toast(res.error, "error");
    toast("Preferências salvas.");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferências de busca</CardTitle>
        <CardDescription>Orientam a busca de vagas e a aderência. Empresas excluídas e modalidade são restrições obrigatórias.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Cargos desejados" id="pr-roles"><TagInput id="pr-roles" value={form.desired_roles} onChange={(v) => set("desired_roles", v)} placeholder="Ex.: Desenvolvedor front-end" max={10} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Localizações" id="pr-loc"><TagInput id="pr-loc" value={form.locations} onChange={(v) => set("locations", v)} placeholder="Ex.: São Paulo, Remoto" max={10} /></Field>
          <Field label="Idiomas" id="pr-lang"><TagInput id="pr-lang" value={form.languages} onChange={(v) => set("languages", v)} placeholder="Ex.: português, inglês" max={10} /></Field>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Modalidade</p>
          <div className="flex flex-wrap gap-4">
            {WORK_MODES.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-[13px] cursor-pointer">
                <Checkbox checked={form.work_modes.includes(m.key)} onCheckedChange={(c) => set("work_modes", c ? [...form.work_modes, m.key] : form.work_modes.filter((x) => x !== m.key))} />
                {m.label}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Contratos" id="pr-ct"><TagInput id="pr-ct" value={form.contract_types} onChange={(v) => set("contract_types", v)} placeholder="CLT, PJ…" max={6} /></Field>
          <Field label="Salário mínimo" id="pr-sal"><Input id="pr-sal" type="number" min={0} value={form.min_salary ?? ""} onChange={(e) => set("min_salary", e.target.value ? Number(e.target.value) : null)} /></Field>
          <Field label="Nota mínima de aderência" id="pr-min"><Input id="pr-min" type="number" min={0} max={100} value={form.min_match_score} onChange={(e) => set("min_match_score", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} /></Field>
        </div>
        <Field label="Empresas excluídas" id="pr-ex"><TagInput id="pr-ex" value={form.excluded_companies} onChange={(v) => set("excluded_companies", v)} placeholder="Ex.: empregador atual" max={50} /></Field>
        <Field label="Seu e-mail para respostas (reply-to)" id="pr-email" hint="Obrigatório para enviar pelo Resend: é para onde o recrutador responde.">
          <Input id="pr-email" type="email" value={form.candidate_email ?? ""} onChange={(e) => set("candidate_email", e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button disabled={saving || !hasProfile} onClick={save}>{saving ? <Loader2 className="animate-spin" /> : null} Salvar preferências</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, id, children, hint, className }: { label: string; id: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
