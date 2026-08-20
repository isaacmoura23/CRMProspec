"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AtSign, Globe, Loader2, Mail, MessageCircle, Phone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { analyzeLead, changeLeadStatus } from "@/actions/leads";
import { registerContactMade } from "@/actions/ai";
import { STATUS_LABEL } from "@/services/stats";
import { instagramUrl } from "@/lib/utils";
import { TaskDialog } from "@/features/tasks/task-dialog";
import type { Lead, LeadStatus, User } from "@/types";

export function LeadHeaderActions({ lead, users }: { lead: Lead; users: User[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [analyzing, setAnalyzing] = React.useState(false);

  async function handleAnalyze() {
    setAnalyzing(true);
    try {
      const res = await analyzeLead(lead.id);
      if (!res.ok) {
        toast(res.error ?? "Falha na análise.", "error");
      } else {
        toast("Análise concluída.");
        router.refresh();
      }
    } finally {
      setAnalyzing(false);
    }
  }

  async function openChannel(channel: string, url: string) {
    window.open(url, "_blank", "noopener");
    if (channel === "whatsapp" || channel === "email" || channel === "telefone") {
      await registerContactMade(lead.id, channel);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {lead.whatsapp && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => openChannel("whatsapp", `https://wa.me/${lead.whatsapp!.replace(/\D/g, "")}`)}
        >
          <MessageCircle className="text-primary" /> WhatsApp
        </Button>
      )}
      {instagramUrl(lead.instagram) && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => openChannel("instagram", instagramUrl(lead.instagram)!)}
        >
          <AtSign /> Instagram
        </Button>
      )}
      {lead.website && (
        <Button variant="secondary" size="sm" onClick={() => openChannel("site", lead.website!)}>
          <Globe /> Site
        </Button>
      )}
      {lead.email && (
        <Button variant="secondary" size="sm" onClick={() => openChannel("email", `mailto:${lead.email}`)}>
          <Mail /> E-mail
        </Button>
      )}
      {lead.phone && (
        <Button variant="secondary" size="sm" onClick={() => openChannel("telefone", `tel:${lead.phone!.replace(/\s/g, "")}`)}>
          <Phone /> Ligar
        </Button>
      )}
      <TaskDialog
        leadId={lead.id}
        leadName={lead.company_name}
        users={users}
        trigger={
          <Button variant="secondary" size="sm">
            Criar tarefa
          </Button>
        }
      />
      <Button size="sm" onClick={handleAnalyze} disabled={analyzing}>
        {analyzing ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {analyzing ? "Analisando…" : "Analisar oportunidade"}
      </Button>

      <Select
        value={lead.status}
        onValueChange={async (v) => {
          await changeLeadStatus(lead.id, v as LeadStatus);
          toast(`Status alterado para ${STATUS_LABEL[v as LeadStatus]}.`);
          router.refresh();
        }}
      >
        <SelectTrigger className="h-8 w-auto min-w-36 text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.entries(STATUS_LABEL) as Array<[LeadStatus, string]>).map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
