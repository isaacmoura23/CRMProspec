"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { removeDemoLeads } from "@/actions/leads";

/**
 * Os leads do seed têm score alto e, com a lista ordenada por score, ficavam
 * sempre nas primeiras linhas — parecia que toda prospecção devolvia as
 * mesmas empresas. Agora eles já entram ocultos; esta faixa explica onde
 * foram parar e oferece removê-los de vez.
 */
export function DemoDataNotice({ demoCount, mostrando }: { demoCount: number; mostrando: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [removendo, setRemovendo] = React.useState(false);

  async function remover() {
    setRemovendo(true);
    const res = await removeDemoLeads();
    setRemovendo(false);
    if (res.error) {
      toast(res.error, "error");
      return;
    }
    toast(`${res.removed} leads de demonstração removidos.`);
    router.refresh();
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13px] text-muted-foreground">
      <Sparkles className="size-4 shrink-0 text-faint-foreground" />
      <p className="min-w-0 flex-1">
        {mostrando ? (
          <>
            Mostrando também os <span className="font-medium text-foreground">{demoCount} leads de demonstração</span>,
            que vêm com o sistema e têm score alto.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">{demoCount} leads de demonstração</span> estão ocultos —
            eles vêm com o sistema e apareciam no topo por terem score alto.
          </>
        )}
      </p>
      <Button size="xs" variant="ghost" asChild>
        <Link href={mostrando ? "/leads" : "/leads?demo=1"}>
          {mostrando ? <EyeOff /> : <Eye />} {mostrando ? "Ocultar" : "Mostrar"}
        </Link>
      </Button>
      <Button size="xs" variant="secondary" disabled={removendo} onClick={remover}>
        {removendo ? <Loader2 className="animate-spin" /> : <Trash2 />} Remover de vez
      </Button>
    </div>
  );
}
