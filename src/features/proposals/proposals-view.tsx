"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createProposal, setProposalStatus } from "@/actions/management";
import { formatCurrency, formatDate } from "@/lib/format";
import type { Lead, Proposal, ProposalStatus } from "@/types";

const STATUS_OPTIONS: Array<[ProposalStatus, string]> = [
  ["rascunho", "Rascunho"],
  ["enviada", "Enviada"],
  ["visualizada", "Visualizada"],
  ["aceita", "Aceita"],
  ["recusada", "Recusada"],
  ["expirada", "Expirada"],
];

export function ProposalsView({
  proposals,
  leads,
  currency,
}: {
  proposals: Proposal[];
  leads: Lead[];
  currency: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [leadId, setLeadId] = React.useState("");
  const [service, setService] = React.useState("");
  const [value, setValue] = React.useState("");
  const [discount, setDiscount] = React.useState("0");
  const [validDays, setValidDays] = React.useState("15");
  const [notes, setNotes] = React.useState("");

  const openLeads = leads.filter((l) => !l.archived && l.status !== "perdido");

  async function submit() {
    setSaving(true);
    try {
      const res = await createProposal({
        lead_id: leadId,
        service,
        value: parseFloat(value.replace(",", ".")) || 0,
        discount: parseFloat(discount) || 0,
        valid_days: parseInt(validDays, 10) || 15,
        notes: notes || undefined,
      });
      if (res.error) {
        toast(res.error, "error");
        return;
      }
      toast("Proposta criada como rascunho.");
      setOpen(false);
      setService("");
      setValue("");
      setNotes("");
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
              <Plus /> Nova proposta
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nova proposta</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Cliente / Lead</Label>
                <Select value={leadId} onValueChange={setLeadId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o lead" />
                  </SelectTrigger>
                  <SelectContent>
                    {openLeads.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.company_name} — {l.city}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Serviço</Label>
                <Input value={service} onChange={(e) => setService(e.target.value)} placeholder="Ex.: Site imobiliário com filtros" />
              </div>
              <div className="space-y-1.5">
                <Label>Valor ({currency})</Label>
                <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="3500" />
              </div>
              <div className="space-y-1.5">
                <Label>Desconto (%)</Label>
                <Input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Validade (dias)</Label>
                <Input type="number" value={validDays} onChange={(e) => setValidDays(e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Observações</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Condições, escopo, parcelamento…" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={submit} disabled={saving || !leadId || !service}>
                {saving && <Loader2 className="animate-spin" />} Criar proposta
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Cliente</TableHead>
              <TableHead>Serviço</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead>Desconto</TableHead>
              <TableHead>Validade</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposals.map((p) => {
              const lead = leads.find((l) => l.id === p.lead_id);
              const final = p.value * (1 - p.discount / 100);
              return (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link href={`/leads/${p.lead_id}`} className="text-[13px] font-medium hover:text-primary">
                      {lead?.company_name ?? "Lead removido"}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-[13px] text-muted-foreground" title={p.service}>
                    {p.service}
                  </TableCell>
                  <TableCell className="text-[13px] font-medium tabular-nums">
                    {formatCurrency(final, currency)}
                    {p.discount > 0 && (
                      <span className="ml-1 text-[11px] font-normal text-faint-foreground line-through">
                        {formatCurrency(p.value, currency)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{p.discount}%</TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{formatDate(p.valid_until)}</TableCell>
                  <TableCell>
                    <Select
                      value={p.status}
                      onValueChange={async (v) => {
                        await setProposalStatus(p.id, v as ProposalStatus);
                        toast(
                          v === "aceita"
                            ? "Proposta aceita — lead convertido em cliente! 🎉"
                            : "Status da proposta atualizado."
                        );
                        router.refresh();
                      }}
                    >
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map(([v, l]) => (
                          <SelectItem key={v} value={v}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {proposals.length === 0 && (
          <p className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <FileText className="size-4" /> Nenhuma proposta criada ainda.
          </p>
        )}
      </Card>
    </div>
  );
}
