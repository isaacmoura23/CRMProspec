"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { createLeadManual, type ManualLeadInput } from "@/actions/leads";

const EMPTY: ManualLeadInput = {
  company_name: "",
  contact_name: "",
  segment: "",
  phone: "",
  whatsapp: "",
  email: "",
  website: "",
  instagram: "",
  country: "Brasil",
  state: "",
  city: "",
  description: "",
};

export function NewLeadDialog() {
  const router = useRouter();
  const params = useSearchParams();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(params.get("novo") === "1");
  const [form, setForm] = React.useState<ManualLeadInput>(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicate, setDuplicate] = React.useState<{ id: string; company: string; reason: string } | null>(null);

  function set<K extends keyof ManualLeadInput>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(force = false) {
    setSaving(true);
    setError(null);
    try {
      const res = await createLeadManual(form, { force });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      if ("duplicate" in res) {
        setDuplicate(res.duplicate);
        return;
      }
      toast("Lead criado com sucesso.");
      setOpen(false);
      setForm(EMPTY);
      setDuplicate(null);
      router.push(`/leads/${res.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setDuplicate(null); setError(null); } }}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Plus /> Novo lead
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Adicionar lead manualmente</DialogTitle>
          <DialogDescription>
            Empresa, nicho e cidade são obrigatórios. O score é calculado automaticamente.
          </DialogDescription>
        </DialogHeader>

        {duplicate ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-warning/30 bg-warning-soft p-4">
              <p className="text-sm font-medium text-warning">Este lead aparentemente já existe.</p>
              <p className="mt-1 text-[13px] text-warning/90">
                <span className="font-medium">{duplicate.company}</span> foi encontrado com {duplicate.reason}.
              </p>
            </div>
            <DialogFooter className="mt-0">
              <Button variant="ghost" onClick={() => setDuplicate(null)}>
                Revisar dados
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  router.push(`/leads/${duplicate.id}`);
                }}
              >
                Abrir existente
              </Button>
              <Button onClick={() => submit(true)} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} Criar mesmo assim
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Nome da empresa *</Label>
                <Input value={form.company_name} onChange={(e) => set("company_name", e.target.value)} placeholder="Ex.: Imobiliária Costa Azul" />
              </div>
              <div className="space-y-1.5">
                <Label>Nicho *</Label>
                <Input value={form.segment} onChange={(e) => set("segment", e.target.value)} placeholder="Ex.: Imobiliária" />
              </div>
              <div className="space-y-1.5">
                <Label>Contato</Label>
                <Input value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} placeholder="Nome da pessoa" />
              </div>
              <div className="space-y-1.5">
                <Label>Telefone</Label>
                <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+55 11 3333-0000" />
              </div>
              <div className="space-y-1.5">
                <Label>WhatsApp</Label>
                <Input value={form.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} placeholder="+55 11 99999-0000" />
              </div>
              <div className="space-y-1.5">
                <Label>E-mail</Label>
                <Input value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="contato@empresa.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Instagram</Label>
                <Input value={form.instagram} onChange={(e) => set("instagram", e.target.value)} placeholder="@empresa" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Site</Label>
                <Input value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://… (deixe vazio se não tiver)" />
              </div>
              <div className="space-y-1.5">
                <Label>Cidade *</Label>
                <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Estado</Label>
                <Input value={form.state} onChange={(e) => set("state", e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>País *</Label>
                <Input value={form.country} onChange={(e) => set("country", e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Descrição</Label>
                <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="O que você sabe sobre esse negócio?" />
              </div>
            </div>

            {error && (
              <p className="mt-3 flex items-center gap-2 text-[13px] text-danger">
                <AlertCircle className="size-4" /> {error}
              </p>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={() => submit(false)} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} Criar lead
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
