"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2, Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { createAutomation, deleteAutomation, toggleAutomation } from "@/actions/management";
import { timeAgo } from "@/lib/format";
import type { AutomationRule } from "@/types";

const TRIGGERS = [
  "Lead criado",
  "Lead recebe score",
  "Lead respondeu",
  "Reunião concluída",
  "Proposta enviada",
  "Proposta aceita",
  "Lead sem contato há 5 dias",
];

const CONDITIONS = ["Sempre", "Score ≥ 80", "Score ≥ 60", "Sem site", "Nicho prioritário"];

const ACTIONS = [
  "Mover para Qualificado",
  "Criar tarefa de contato",
  "Adicionar à lista Alta prioridade",
  "Pausar follow-ups automáticos",
  "Criar tarefa para o vendedor",
  "Criar tarefa \"Enviar proposta\"",
  "Notificar responsável",
];

export function AutomationsView({ rules }: { rules: AutomationRule[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState("");
  const [trigger, setTrigger] = React.useState(TRIGGERS[0]!);
  const [condition, setCondition] = React.useState(CONDITIONS[0]!);
  const [action1, setAction1] = React.useState(ACTIONS[0]!);
  const [action2, setAction2] = React.useState<string>("__none__");

  async function submit() {
    setSaving(true);
    try {
      const actions = [action1, ...(action2 !== "__none__" ? [action2] : [])];
      const res = await createAutomation({
        name: name || `${trigger} → ${action1}`,
        trigger,
        condition,
        actions,
      });
      if (res.error) {
        toast(res.error, "error");
        return;
      }
      toast("Automação criada e ativada.");
      setOpen(false);
      setName("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus /> Nova automação
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nova automação</DialogTitle>
              <DialogDescription>Trigger → Condição → Ação. O motor executa quando o evento acontecer.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Nome (opcional)</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Priorizar leads quentes" />
              </div>
              <div className="rounded-xl border border-border bg-surface-hover/40 p-4 space-y-3">
                <BuilderRow label="QUANDO">
                  <Select value={trigger} onValueChange={setTrigger}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TRIGGERS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </BuilderRow>
                <BuilderRow label="SE">
                  <Select value={condition} onValueChange={setCondition}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONDITIONS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </BuilderRow>
                <BuilderRow label="ENTÃO">
                  <Select value={action1} onValueChange={setAction1}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ACTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </BuilderRow>
                <BuilderRow label="E">
                  <Select value={action2} onValueChange={setAction2}>
                    <SelectTrigger><SelectValue placeholder="Nenhuma ação extra" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Nenhuma ação extra</SelectItem>
                      {ACTIONS.filter((a) => a !== action1).map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </BuilderRow>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={submit} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} Criar automação
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {rules.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-[13px] text-muted-foreground">
              Nenhuma automação criada. Automatize movimentos repetitivos: priorizar leads
              quentes, pausar cadências ao receber resposta, criar tarefas após reuniões.
            </CardContent>
          </Card>
        )}
        {rules.map((rule) => (
          <Card key={rule.id}>
            <CardContent className="flex items-start gap-4 p-4">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft">
                <Bot className="size-4 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold">{rule.name}</span>
                  <Badge variant={rule.active ? "default" : "neutral"}>
                    {rule.active ? "Ativa" : "Pausada"}
                  </Badge>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
                  <Zap className="size-3.5 text-warning" />
                  <span className="font-medium text-foreground">{rule.trigger}</span>
                  <span>·</span>
                  se <span className="font-medium text-foreground">{rule.condition}</span>
                  <span>→</span>
                  {rule.actions.join(" + ")}
                </p>
                <p className="mt-1 text-[11px] text-faint-foreground">
                  {rule.runs} execuções · criada {timeAgo(rule.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={rule.active}
                  aria-label={`${rule.active ? "Desativar" : "Ativar"} a automação ${rule.name}`}
                  onCheckedChange={async () => {
                    try {
                      await toggleAutomation(rule.id);
                      router.refresh();
                    } catch {
                      toast("Não conseguimos alterar a automação. Tente novamente.", "error");
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label={`Excluir a automação ${rule.name}`}
                  onClick={async () => {
                    if (!confirm("Excluir esta automação?")) return;
                    try {
                      await deleteAutomation(rule.id);
                      toast("Automação excluída.");
                      router.refresh();
                    } catch {
                      toast("Não conseguimos excluir a automação. Tente novamente.", "error");
                    }
                  }}
                  className="rounded p-1 text-faint-foreground hover:bg-danger-soft hover:text-danger cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function BuilderRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] font-bold uppercase tracking-wider text-primary">
        {label}
      </span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
