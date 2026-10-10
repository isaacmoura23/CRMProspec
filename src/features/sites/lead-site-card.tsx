"use client";

import { ExternalLink, Loader2, Hammer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildSiteNow } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime } from "@/lib/format";

/** A prévia do site do lead (ou por que ainda não existe), na aba Dossiê. */
export function LeadSiteCard({
  previewPath,
  status,
  readyAt,
  expiresAt,
  gateReason,
  canRun,
  leadId,
}: {
  previewPath: string | null;
  status: string | null;
  readyAt: string | null;
  expiresAt: string | null;
  /** Por que a porta está fechada; `null` = aberta. */
  gateReason: string | null;
  canRun: boolean;
  leadId: string;
}) {
  const { run, pending } = useAgentAction();
  return (
    <section aria-label="Prévia do site" className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">Prévia do site</h4>
        {status && <Badge variant={status === "pronto" ? "good" : status === "falhou" ? "danger" : "info"}>{status === "pronto" ? "Pronta" : status === "falhou" ? "Não entregue" : "Em andamento"}</Badge>}
      </div>
      {previewPath ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Verificada {readyAt ? `em ${formatDateTime(readyAt)}` : ""} · no ar até {formatDateTime(expiresAt)}.{" "}
          <a href={previewPath} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            Abrir a prévia <ExternalLink className="size-3.5" />
          </a>
        </p>
      ) : gateReason ? (
        <p className="mt-2 text-[13px] text-muted-foreground">Ainda não: {gateReason}</p>
      ) : (
        <p className="mt-2 text-[13px] text-muted-foreground">Tudo pronto para construir: há interesse registrado, reunião marcada e dossiê válido.</p>
      )}
      {canRun && !gateReason && (
        <Button className="mt-3" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => buildSiteNow(leadId))}>
          {pending ? <Loader2 className="animate-spin" /> : <Hammer />} {previewPath ? "Refazer a prévia" : "Construir a prévia agora"}
        </Button>
      )}
    </section>
  );
}
