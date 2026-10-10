"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CreativeView } from "@/services/growth/panel";
import type { CreativeStatus } from "@/types/agents";

const LABEL: Record<CreativeStatus, string> = { pendente: "Arte esperando você", aprovado: "Arte aprovada", recusado: "Arte recusada", expirado: "Arte expirou", falhou: "Arte não saiu" };
const BADGE: Record<CreativeStatus, "warning" | "good" | "outline" | "danger"> = { pendente: "warning", aprovado: "good", recusado: "outline", expirado: "outline", falhou: "danger" };

/**
 * Prévia de uma arte (imagem ou vídeo) feita em código, antes de qualquer clique. Mostra o que foi
 * verificado e quem a escreveu. A mídia vem de uma rota que exige sessão; só depois da aprovação ela
 * ganha endereço público.
 */
export function CreativePreview({ creative, className }: { creative: CreativeView; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const src = (file: string) => `/api/criativos/${creative.id}/${file}`;
  const tall = creative.height > creative.width;
  const frame = tall ? "max-h-96" : "max-h-72";

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 pb-1.5">
        <Badge variant={BADGE[creative.status]}>{LABEL[creative.status]}</Badge>
        <span className="text-xs text-muted-foreground">
          {creative.width}×{creative.height}
          {creative.duration_s ? ` · ${creative.duration_s.toFixed(1).replace(".", ",")} s` : ""} · {creative.builder === "claude-code" ? "escrita pelo Claude Code" : "modelo de arte"}
        </span>
      </div>

      {creative.status === "falhou" ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{creative.error ?? "A arte não foi gerada."}</p>
      ) : creative.files.length > 0 ? (
        creative.kind === "video" ? (
          <video className={`${frame} w-auto max-w-full rounded-lg border border-border bg-black`} controls preload="metadata" poster={creative.files.includes("poster.png") ? src("poster.png") : undefined} src={src("creative.mp4")} aria-label="Vídeo do post (sem áudio)" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={`${frame} w-auto max-w-full rounded-lg border border-border`} src={src("creative.png")} alt={`Arte do post: ${creative.headline}`} loading="lazy" />
        )
      ) : null}

      {creative.checks.length > 0 && (
        <div className="pt-1.5">
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Ocultar verificações" : `Ver verificações (${creative.checks.filter((c) => c.ok).length}/${creative.checks.length})`}
          </Button>
          {open && (
            <ul className="mt-1 space-y-0.5 rounded-lg bg-surface-hover px-3 py-2 text-[13px]">
              {creative.checks.map((c, i) => (
                <li key={`${c.name}-${i}`} className={c.ok ? "" : "text-danger"}>
                  <span className="font-medium">
                    {c.ok ? "✓" : "✗"} {c.name}.
                  </span>{" "}
                  <span className="text-muted-foreground">{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
