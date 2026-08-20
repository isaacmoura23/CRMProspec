"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpDown,
  Archive,
  AtSign,
  Columns3,
  Download,
  Gauge,
  Globe,
  Loader2,
  Megaphone,
  Phone,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScoreBadge } from "@/components/score-badge";
import { useToast } from "@/components/ui/toast";
import { timeAgo, daysUntil } from "@/lib/format";
import {
  bulkAnalyze,
  bulkArchive,
  bulkAssign,
  bulkCampaign,
  bulkRescore,
  bulkStatus,
  exportLeadsCsv,
} from "@/actions/leads";
import { STATUS_LABEL } from "@/services/stats";
import type { Campaign, Lead, LeadStatus, User } from "@/types";
import { cn, instagramUrl } from "@/lib/utils";

export interface LeadRow extends Lead {
  problem: string | null;
  next_action: string | null;
}

const STATUS_BADGE: Partial<Record<LeadStatus, "neutral" | "info" | "warning" | "good" | "hot" | "danger" | "default" | "cold">> = {
  novo: "neutral",
  analisado: "info",
  qualificado: "info",
  pronto_contato: "default",
  contatado: "warning",
  respondeu: "warning",
  interessado: "hot",
  demo: "hot",
  reuniao: "hot",
  proposta: "info",
  negociacao: "default",
  fechado: "good",
  perdido: "danger",
};

const ALL_COLUMNS = [
  { key: "score", label: "Score" },
  { key: "nicho", label: "Nicho" },
  { key: "cidade", label: "Cidade" },
  { key: "canais", label: "Canais" },
  { key: "problema", label: "Problema" },
  { key: "status", label: "Status" },
  { key: "resp", label: "Responsável" },
  { key: "contato", label: "Último contato" },
  { key: "proxima", label: "Próxima ação" },
] as const;

type ColKey = (typeof ALL_COLUMNS)[number]["key"];

export function LeadsTable({
  leads,
  users,
  campaigns,
}: {
  leads: LeadRow[];
  users: User[];
  campaigns: Campaign[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { toast } = useToast();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState(false);
  const [hidden, setHidden] = React.useState<Set<ColKey>>(new Set());

  const allSelected = leads.length > 0 && selected.size === leads.length;
  const ids = React.useMemo(() => [...selected], [selected]);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function sortBy(key: string) {
    const next = new URLSearchParams(params.toString());
    const current = next.get("ordenar");
    const dir = next.get("dir");
    if (current === key && dir !== "asc") next.set("dir", "asc");
    else next.set("dir", "desc");
    next.set("ordenar", key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  async function run(fn: () => Promise<unknown>, message: string) {
    setPending(true);
    try {
      await fn();
      toast(message);
      setSelected(new Set());
      router.refresh();
    } catch {
      toast("Algo deu errado. Tente novamente.", "error");
    } finally {
      setPending(false);
    }
  }

  async function handleExport() {
    const csv = await exportLeadsCsv(ids.length ? ids : leads.map((l) => l.id));
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("CSV exportado.");
  }

  const show = (key: ColKey) => !hidden.has(key);

  return (
    <div className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          {selected.size > 0 ? (
            <span className="font-medium text-foreground">{selected.size} selecionados</span>
          ) : (
            `${leads.length} leads`
          )}
        </p>
        <div className="flex items-center gap-1.5">
          {selected.size > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Ações em lote
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem
                  onClick={() =>
                    run(() => bulkAnalyze(ids), `Análise concluída para ${Math.min(ids.length, 25)} leads.`)
                  }
                >
                  <Sparkles /> Analisar com IA
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => run(() => bulkRescore(ids), "Scores recalculados.")}>
                  <Gauge /> Recalcular score
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Alterar status</DropdownMenuLabel>
                {(["qualificado", "pronto_contato", "contatado", "perdido"] as LeadStatus[]).map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => run(() => bulkStatus(ids, s), `Status alterado para ${STATUS_LABEL[s]}.`)}
                  >
                    {STATUS_LABEL[s]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Atribuir a</DropdownMenuLabel>
                {users.map((u) => (
                  <DropdownMenuItem
                    key={u.id}
                    onClick={() => run(() => bulkAssign(ids, u.id), `Leads atribuídos a ${u.name}.`)}
                  >
                    <UserRound /> {u.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Adicionar à campanha</DropdownMenuLabel>
                {campaigns.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => run(() => bulkCampaign(ids, c.id), `Adicionados à campanha ${c.name}.`)}
                  >
                    <Megaphone /> {c.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  destructive
                  onClick={() => {
                    if (
                      confirm(
                        `Arquivar ${ids.length} leads? Eles saem das listagens, mas o histórico é mantido.`
                      )
                    ) {
                      run(() => bulkArchive(ids), "Leads arquivados.");
                    }
                  }}
                >
                  <Archive /> Arquivar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="secondary" size="sm" onClick={handleExport}>
            <Download /> Exportar
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm">
                <Columns3 /> Colunas
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ALL_COLUMNS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={show(c.key)}
                  onCheckedChange={(v) =>
                    setHidden((prev) => {
                      const next = new Set(prev);
                      if (v) next.delete(c.key);
                      else next.add(c.key);
                      return next;
                    })
                  }
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface shadow-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected ? true : selected.size > 0 ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>
                <button onClick={() => sortBy("empresa")} className="flex items-center gap-1 hover:text-foreground cursor-pointer">
                  Empresa <ArrowUpDown className="size-3" />
                </button>
              </TableHead>
              {show("score") && (
                <TableHead>
                  <button onClick={() => sortBy("score")} className="flex items-center gap-1 hover:text-foreground cursor-pointer">
                    Score <ArrowUpDown className="size-3" />
                  </button>
                </TableHead>
              )}
              {show("nicho") && <TableHead>Nicho</TableHead>}
              {show("cidade") && <TableHead>Cidade</TableHead>}
              {show("canais") && <TableHead>Canais</TableHead>}
              {show("problema") && <TableHead className="min-w-56">Problema identificado</TableHead>}
              {show("status") && <TableHead>Status</TableHead>}
              {show("resp") && <TableHead>Resp.</TableHead>}
              {show("contato") && (
                <TableHead>
                  <button onClick={() => sortBy("contato")} className="flex items-center gap-1 hover:text-foreground cursor-pointer">
                    Últ. contato <ArrowUpDown className="size-3" />
                  </button>
                </TableHead>
              )}
              {show("proxima") && <TableHead>Próxima ação</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => {
              const responsible = users.find((u) => u.id === lead.assigned_to);
              return (
                <TableRow
                  key={lead.id}
                  data-state={selected.has(lead.id) ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => router.push(`/leads/${lead.id}`)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(lead.id)} onCheckedChange={() => toggle(lead.id)} />
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-52 truncate text-[13px] font-medium">{lead.company_name}</span>
                    {lead.contact_name && (
                      <span className="block text-xs text-muted-foreground">{lead.contact_name}</span>
                    )}
                  </TableCell>
                  {show("score") && (
                    <TableCell>
                      <ScoreBadge score={lead.lead_score} />
                    </TableCell>
                  )}
                  {show("nicho") && (
                    <TableCell className="text-[13px] text-muted-foreground">{lead.segment}</TableCell>
                  )}
                  {show("cidade") && (
                    <TableCell className="text-[13px] text-muted-foreground">{lead.city}</TableCell>
                  )}
                  {show("canais") && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <span className="flex items-center gap-1.5">
                        {lead.website ? (
                          <a href={lead.website} target="_blank" rel="noreferrer" title={lead.website} className="text-muted-foreground hover:text-primary">
                            <Globe className="size-3.5" />
                          </a>
                        ) : (
                          <span title="Sem site" className="text-border-strong">
                            <Globe className="size-3.5" />
                          </span>
                        )}
                        {instagramUrl(lead.instagram) ? (
                          <a
                            href={instagramUrl(lead.instagram)!}
                            target="_blank"
                            rel="noreferrer"
                            title={lead.instagram ?? ""}
                            className="text-muted-foreground hover:text-primary"
                          >
                            <AtSign className="size-3.5" />
                          </a>
                        ) : (
                          <span className="text-border-strong">
                            <AtSign className="size-3.5" />
                          </span>
                        )}
                        {lead.phone || lead.whatsapp ? (
                          <span title={lead.whatsapp ?? lead.phone ?? ""} className="text-muted-foreground">
                            <Phone className="size-3.5" />
                          </span>
                        ) : (
                          <span className="text-border-strong">
                            <Phone className="size-3.5" />
                          </span>
                        )}
                      </span>
                    </TableCell>
                  )}
                  {show("problema") && (
                    <TableCell>
                      <span className="block max-w-72 truncate text-[13px] text-muted-foreground" title={lead.problem ?? undefined}>
                        {lead.problem ?? <span className="text-faint-foreground">Não analisado</span>}
                      </span>
                    </TableCell>
                  )}
                  {show("status") && (
                    <TableCell>
                      <Badge variant={STATUS_BADGE[lead.status] ?? "neutral"}>{STATUS_LABEL[lead.status]}</Badge>
                    </TableCell>
                  )}
                  {show("resp") && (
                    <TableCell className="text-[13px] text-muted-foreground">
                      {responsible?.name.split(" ")[0] ?? "—"}
                    </TableCell>
                  )}
                  {show("contato") && (
                    <TableCell className="text-[13px] text-muted-foreground">
                      {lead.last_contact_at ? timeAgo(lead.last_contact_at) : "—"}
                    </TableCell>
                  )}
                  {show("proxima") && (
                    <TableCell>
                      {lead.next_action ? (
                        <span
                          className={cn(
                            "text-[13px]",
                            lead.next_follow_up_at && daysUntil(lead.next_follow_up_at) < 0
                              ? "font-medium text-danger"
                              : "text-muted-foreground"
                          )}
                        >
                          {lead.next_action}
                        </span>
                      ) : (
                        <span className="text-[13px] text-faint-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
