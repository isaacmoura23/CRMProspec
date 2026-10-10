"use client";

import * as React from "react";
import { Check, ClipboardCheck, Pencil, X } from "lucide-react";
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
  seller: "Vendedor",
  presence: "Analista de Presença",
  "site-builder": "Programador de Sites",
  "traffic-manager": "Gestor de Tráfego",
  "social-media": "Mídias Sociais",
};

/** Mensagem de WhatsApp: o dono lê o texto exato, pode editar e só então aprova. */
function OutreachApprovalItem({ approval: a, canDecide, busy, onDecide }: { approval: Approval; canDecide: boolean; busy: boolean; onDecide: (approve: boolean, editedBody?: string) => void }) {
  const original = String((a.payload as { body?: string }).body ?? "");
  const phone = String((a.payload as { phone?: string }).phone ?? "");
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(original);
  const changed = text.trim() !== original.trim();

  return (
    <li className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{a.title}</span>
        <Badge variant="outline">{AGENT_LABEL[a.agent] ?? a.agent}</Badge>
        <span className="text-xs text-muted-foreground">{a.detail}</span>
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <label htmlFor={`edit-${a.id}`} className="text-xs font-medium text-muted-foreground">
            Texto que será enviado para {phone}
          </label>
          <textarea
            id={`edit-${a.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-xs text-muted-foreground">
            {a.kind === "conversation_reply"
              ? "Sem links, preços nem promessas de resultado."
              : "Sem links nem promessas de resultado. O aviso para parar de receber é recolocado se você o apagar."}
          </p>
        </div>
      ) : (
        <blockquote className="whitespace-pre-wrap rounded-lg border-l-2 border-primary bg-surface-hover px-3 py-2 text-[13px]">{original}</blockquote>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-faint-foreground">
          Pedido {timeAgo(a.created_at)} · expira em {formatDateTime(a.expires_at)}
        </span>
        {canDecide ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {!editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil /> Editar
              </Button>
            )}
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(false)}>
              <X /> Recusar
            </Button>
            <Button size="sm" disabled={busy || text.trim().length === 0} onClick={() => onDecide(true, editing && changed ? text : undefined)}>
              <Check /> {editing && changed ? "Aprovar com a edição" : "Aprovar"}
            </Button>
          </div>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">Só owner e admin decidem.</span>
        )}
      </div>
    </li>
  );
}

/** Post e campanha são decididos na tela do próprio agente (lá estão a edição, a imagem e os tetos); aqui só o aviso e a recusa. */
function LinkedApprovalItem({ approval: a, canDecide, busy, onReject }: { approval: Approval; canDecide: boolean; busy: boolean; onReject: () => void }) {
  const href = a.kind === "social_post" ? "/agentes/social-media" : "/agentes/traffic-manager";
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{a.title}</span>
          <Badge variant="outline">{AGENT_LABEL[a.agent] ?? a.agent}</Badge>
        </div>
        {a.detail && <p className="text-[13px] text-muted-foreground">{a.detail}</p>}
        <p className="text-xs text-faint-foreground">
          {a.kind === "social_post" ? "Só sai com o seu clique em “Aprovar e publicar”." : "Aprovar o rascunho não gasta nada: ativar é outro clique."} · expira em {formatDateTime(a.expires_at)}
        </p>
      </div>
      <div className="flex gap-2">
        <a href={href} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90">
          Revisar
        </a>
        {canDecide && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onReject}>
            <X /> Recusar
          </Button>
        )}
      </div>
    </li>
  );
}

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
            O que os agentes em modo “Em aprovação” querem fazer, inclusive as mensagens de WhatsApp com o texto exato. Nada disto executa antes do seu clique, e pedidos sem resposta expiram em 3 dias.
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
            {pending.map((a) =>
              a.kind === "social_post" || a.kind === "ad_campaign" ? (
                <LinkedApprovalItem key={a.id} approval={a} canDecide={canDecide} busy={busy} onReject={() => run(() => decideAgentApproval(a.id, false))} />
              ) : a.kind === "outreach_message" || a.kind === "conversation_reply" ? (
                <OutreachApprovalItem key={a.id} approval={a} canDecide={canDecide} busy={busy} onDecide={(approve, editedBody) => run(() => decideAgentApproval(a.id, approve, editedBody))} />
              ) : (
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
              )
            )}
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
