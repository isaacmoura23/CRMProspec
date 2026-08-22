"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { CalendarPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createTask } from "@/actions/tasks";
import type { User } from "@/types";

const TYPES = [
  ["ligar", "Ligar"],
  ["mensagem", "Enviar mensagem"],
  ["proposta", "Enviar proposta"],
  ["follow_up", "Follow-up"],
  ["reuniao", "Reunião"],
  ["demo", "Produzir demo"],
  ["outra", "Outra"],
] as const;

export function TaskDialog({
  leadId,
  leadName,
  users,
  trigger,
  defaultOpen,
}: {
  leadId: string | null;
  leadName?: string;
  users: User[];
  trigger?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  // `defaultOpen` vem de `?nova=1`. Lido só na montagem, o atalho da paleta
  // não abria o diálogo para quem já estava em /tarefas.
  const openedByUrl = Boolean(defaultOpen);
  const [localOpen, setLocalOpen] = React.useState(false);
  const open = openedByUrl || localOpen;
  const [saving, setSaving] = React.useState(false);
  const [type, setType] = React.useState<string>("follow_up");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [date, setDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = React.useState("09:00");
  const [priority, setPriority] = React.useState("media");
  const [assignedTo, setAssignedTo] = React.useState<string>("");

  async function submit() {
    setSaving(true);
    try {
      const res = await createTask({
        lead_id: leadId,
        type: type as never,
        title: title || `${TYPES.find(([k]) => k === type)?.[1]}${leadName ? ` — ${leadName}` : ""}`,
        description: description || undefined,
        due_date: date,
        due_time: time,
        priority: priority as never,
        assigned_to: assignedTo || undefined,
      });
      if ("error" in res) {
        toast(res.error, "error");
        return;
      }
      toast("Tarefa criada.");
      closeDialog();
      setTitle("");
      setDescription("");
      router.refresh();
    } catch {
      toast("Não conseguimos criar a tarefa. Tente novamente.", "error");
    } finally {
      setSaving(false);
    }
  }

  function closeDialog() {
    setLocalOpen(false);
    // Sem limpar o parâmetro, o diálogo reabriria no próximo render.
    if (openedByUrl) router.replace(pathname, { scroll: false });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? setLocalOpen(true) : closeDialog())}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="secondary">
            <CalendarPlus /> Criar tarefa
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova tarefa{leadName ? ` — ${leadName}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Tipo</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Prioridade</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="alta">Alta</SelectItem>
                <SelectItem value="media">Média</SelectItem>
                <SelectItem value="baixa">Baixa</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Título</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Enviar primeira abordagem" />
          </div>
          <div className="space-y-1.5">
            <Label>Data</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Horário</Label>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Responsável</Label>
            <Select value={assignedTo} onValueChange={setAssignedTo}>
              <SelectTrigger>
                <SelectValue placeholder="Eu mesmo" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Descrição</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Contexto ou detalhes (opcional)" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />} Criar tarefa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
