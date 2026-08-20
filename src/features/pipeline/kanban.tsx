"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  Flame,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScoreBadge } from "@/components/score-badge";
import { useToast } from "@/components/ui/toast";
import { changeLeadStage } from "@/actions/leads";
import { createStage, deleteStage, moveStage, renameStage } from "@/actions/pipeline";
import { daysSince, formatCurrency, timeAgo } from "@/lib/format";
import type { Lead, PipelineStage, User } from "@/types";
import { cn } from "@/lib/utils";

export interface KanbanLead extends Lead {
  next_action: string | null;
}

export function PipelineKanban({
  stages,
  leads,
  users,
  currency,
}: {
  stages: PipelineStage[];
  leads: KanbanLead[];
  users: User[];
  currency: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<PipelineStage | null>(null);
  const [newName, setNewName] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addName, setAddName] = React.useState("");

  const ordered = [...stages].sort((a, b) => a.order - b.order);

  async function onDrop(stageId: string) {
    setOverStage(null);
    if (!dragging) return;
    const lead = leads.find((l) => l.id === dragging);
    setDragging(null);
    if (!lead || lead.pipeline_stage_id === stageId) return;
    await changeLeadStage(lead.id, stageId);
    const stage = stages.find((s) => s.id === stageId);
    toast(`${lead.company_name} movido para ${stage?.name}.`);
    router.refresh();
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {ordered.map((stage) => {
        const stageLeads = leads
          .filter((l) => l.pipeline_stage_id === stage.id)
          .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0));
        const totalValue = stageLeads.reduce((acc, l) => acc + (l.potential_value ?? 0), 0);

        return (
          <div
            key={stage.id}
            className={cn(
              "flex w-64 shrink-0 flex-col rounded-xl border bg-surface-hover/50 transition-colors",
              overStage === stage.id ? "border-primary bg-primary-soft/40" : "border-border"
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(stage.id);
            }}
            onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
            onDrop={() => onDrop(stage.id)}
          >
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: stage.color ?? "#94a3b8" }}
                />
                <span className="text-[13px] font-semibold">{stage.name}</span>
                <span className="text-xs text-faint-foreground">{stageLeads.length}</span>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded p-1 text-faint-foreground hover:bg-surface hover:text-foreground cursor-pointer">
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => {
                      setRenaming(stage);
                      setNewName(stage.name);
                    }}
                  >
                    <Pencil /> Renomear
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={async () => { await moveStage(stage.id, "left"); router.refresh(); }}>
                    <ArrowLeftRight /> Mover para a esquerda
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={async () => { await moveStage(stage.id, "right"); router.refresh(); }}>
                    <ArrowLeftRight /> Mover para a direita
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    destructive
                    onClick={async () => {
                      const res = await deleteStage(stage.id);
                      if (res.error) toast(res.error, "error");
                      else {
                        toast("Etapa excluída.");
                        router.refresh();
                      }
                    }}
                  >
                    <Trash2 /> Excluir etapa
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {totalValue > 0 && (
              <p className="px-3 pb-1.5 text-[11px] text-muted-foreground">
                {formatCurrency(totalValue, currency)} em potencial
              </p>
            )}

            <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
              {stageLeads.map((lead) => {
                const responsible = users.find((u) => u.id === lead.assigned_to);
                const inStage = lead.stage_entered_at ? daysSince(lead.stage_entered_at) : null;
                return (
                  <Link
                    key={lead.id}
                    href={`/leads/${lead.id}`}
                    draggable
                    onDragStart={() => setDragging(lead.id)}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      "block rounded-lg border border-border bg-surface p-3 shadow-card transition-all hover:border-border-strong hover:shadow-pop/50",
                      dragging === lead.id && "opacity-50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[13px] font-medium leading-tight">
                        {lead.company_name}
                      </span>
                      <ScoreBadge score={lead.lead_score} size="sm" />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {lead.segment} · {lead.city}
                    </p>
                    {lead.potential_value && (
                      <p className="mt-1.5 text-[12px] font-semibold text-primary">
                        {formatCurrency(lead.potential_value, currency)}
                      </p>
                    )}
                    {lead.next_action && (
                      <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                        → {lead.next_action}
                      </p>
                    )}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[11px] text-faint-foreground">
                        {lead.temperature === "quente" && <Flame className="size-3 text-score-hot" />}
                        {lead.last_contact_at ? `contato ${timeAgo(lead.last_contact_at)}` : "sem contato"}
                        {inStage !== null && inStage > 0 && ` · ${inStage}d na etapa`}
                      </span>
                      {responsible && <Avatar name={responsible.name} size="sm" />}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Nova etapa */}
      <div className="w-56 shrink-0">
        <Button variant="ghost" className="w-full justify-start" onClick={() => setAdding(true)}>
          <Plus /> Nova etapa
        </Button>
      </div>

      {/* Dialog renomear */}
      <Dialog open={Boolean(renaming)} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Renomear etapa</DialogTitle>
          </DialogHeader>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                if (renaming) await renameStage(renaming.id, newName);
                setRenaming(null);
                router.refresh();
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog nova etapa */}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Nova etapa do pipeline</DialogTitle>
          </DialogHeader>
          <Input
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Ex.: Aguardando documentos"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                const res = await createStage(addName);
                if (res.error) toast(res.error, "error");
                else {
                  toast("Etapa criada.");
                  setAdding(false);
                  setAddName("");
                  router.refresh();
                }
              }}
            >
              Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
