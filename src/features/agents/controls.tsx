"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { setAgentMode, setGlobalSwitch, type ActionResult } from "@/actions/agents";
import { MODE_HINT, MODE_LABEL } from "@/features/agents/labels";
import { AGENT_MODES, type AgentMode } from "@/types/agents";

/**
 * Atualiza a página enquanto ela está visível. Os agentes trabalham em segundo
 * plano; sem isto o dashboard mostraria um retrato velho até alguém recarregar.
 */
export function AutoRefresh({ seconds = 8 }: { seconds?: number }) {
  const router = useRouter();
  React.useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

/** Executa uma action, mostra o resultado em toast e atualiza a página. */
export function useAgentAction() {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = React.useTransition();

  const run = React.useCallback(
    (action: () => Promise<ActionResult>) => {
      startTransition(async () => {
        try {
          const res = await action();
          toast(res.ok ? (res.message ?? "Feito.") : res.error, res.ok ? "success" : "error");
          router.refresh();
        } catch {
          toast("Não conseguimos concluir a ação. Tente novamente.", "error");
        }
      });
    },
    [router, toast]
  );
  return { run, pending };
}

export function GlobalSwitch({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <label className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium">
      {pending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <span>{enabled ? "Agentes ligados" : "Agentes desligados"}</span>
      <Switch
        checked={enabled}
        disabled={!canEdit || pending}
        onCheckedChange={(v) => run(() => setGlobalSwitch(v))}
        aria-label="Interruptor geral dos agentes"
      />
    </label>
  );
}

export function ModeSelect({ agent, mode, canEdit }: { agent: string; mode: AgentMode; canEdit: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <div className="space-y-1">
      <Select value={mode} disabled={!canEdit || pending} onValueChange={(v) => run(() => setAgentMode(agent, v))}>
        <SelectTrigger className="h-8 w-44 text-[13px]" aria-label="Modo do agente">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENT_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {MODE_LABEL[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="max-w-64 text-xs text-muted-foreground">{MODE_HINT[mode]}</p>
    </div>
  );
}
