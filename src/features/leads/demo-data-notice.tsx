"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { removeDemoLeads } from "@/actions/leads";

/**
 * Os leads do seed têm score alto e, com a lista ordenada por score, ficam
 * sempre no topo — parece que toda prospecção devolve as mesmas empresas.
 * Este aviso só aparece quando já existem leads reais na base.
 */
export function DemoDataNotice({ demoCount, realCount }: { demoCount: number; realCount: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [removendo, setRemovendo] = React.useState(false);

  if (demoCount === 0 || realCount === 0) return null;

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
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">
      <Sparkles className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{demoCount} leads de demonstração</span> ainda estão na base, junto
        com {realCount} leads reais. Eles têm score alto e aparecem no topo da lista — é o que faz parecer
        que as buscas trazem sempre as mesmas empresas.
      </p>
      <Button size="sm" variant="secondary" disabled={removendo} onClick={remover}>
        {removendo ? <Loader2 className="animate-spin" /> : <Trash2 />} Remover os de demonstração
      </Button>
    </div>
  );
}
