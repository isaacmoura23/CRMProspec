"use client";

import { Check, ClipboardCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { decideAgentApproval } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { Approval, ApprovalStatus } from "@/types/agents";

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pendente: "Pendente",
  aprovado: "Aprovado",
  recusado: "Recusado",
  expirado: "Expirou",
};

const STATUS_BADGE: Record<ApprovalStatus, "warning" | "good" | "outline" | "neutral"> = {
  pendente: "warning",
  aprovado: "good",
  recusado: "outline",
  expirado: "neutral",
};

const AGENT_LABEL: Record<string, string> = {
  "niche-analyst": "Analista de Nicho",
  prospector: "Prospectador",
};

export function ApprovalsView({
  pending,
  history,
  canDecide,
}: {
  pending: Approval[];
  history: Approval[];
  canDecide: boolean;
}) {
  const { run, pending: busy } = useAgentAction();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Aguardando você</CardTitle>
          <CardDescription>
            O que os agentes em modo “Em aprovação” querem fazer. Nada disto executa antes do seu clique, e pedidos sem resposta expiram em 3 dias.
          </CardDescription>
        </CardHeader>
        {pending.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={ClipboardCheck}
              title="Nada para aprovar"
              description="Quando um agente em modo de aprovação decidir iniciar algo, o pedido aparece aqui."
            />
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    <Badge variant="outline">{AGENT_LABEL[a.agent] ?? a.agent}</Badge>
                  </div>
                  {a.detail && <p className="text-[13px] text-muted-foreground">{a.detail}</p>}
                  <p className="text-xs text-faint-foreground">
                    Pedido {timeAgo(a.created_at)} · expira em {formatDateTime(a.expires_at)}
                  </p>
                </div>
                {canDecide ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => decideAgentApproval(a.id, false))}>
                      <X /> Recusar
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => run(() => decideAgentApproval(a.id, true))}>
                      <Check /> Aprovar
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Só owner e admin decidem.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Histórico</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border">
            {history.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-[13px]">
                <Badge variant={STATUS_BADGE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="text-xs text-muted-foreground">{timeAgo(a.decided_at ?? a.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
