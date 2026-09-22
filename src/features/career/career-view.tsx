"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Briefcase, FileText, Inbox, Sparkles } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCareerJobs } from "@/actions/career";
import type { CareerSnapshot } from "@/services/career/service";
import { ResumeTab } from "@/features/career/resume-tab";
import { AnalysisTab } from "@/features/career/analysis-tab";
import { JobsTab } from "@/features/career/jobs-tab";
import { ApplicationsTab } from "@/features/career/applications-tab";

const TABS = [
  { key: "curriculo", label: "Meu currículo", icon: FileText },
  { key: "analise", label: "Análise e melhorias", icon: Sparkles },
  { key: "vagas", label: "Vagas compatíveis", icon: Briefcase },
  { key: "candidaturas", label: "Minhas candidaturas", icon: Inbox },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function CareerView({ data, initialTab }: { data: CareerSnapshot; initialTab: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = React.useState<TabKey>(TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : "curriculo");
  const [activeJobs, setActiveJobs] = React.useState(data.activeJobs);
  // Estado derivado do servidor: quando a página recarrega com dados novos,
  // eles substituem o polling local (ajuste durante o render, sem efeito).
  const [seenJobs, setSeenJobs] = React.useState(data.activeJobs);
  if (seenJobs !== data.activeJobs) {
    setSeenJobs(data.activeJobs);
    setActiveJobs(data.activeJobs);
  }

  // Acompanha jobs em execução com polling real e recarrega a página
  // quando um deles termina — os resultados vêm do servidor, nunca simulados.
  const running = activeJobs.some((j) => j.status === "pendente" || j.status === "processando");
  React.useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const fresh = await getCareerJobs();
        if (cancelled) return;
        const wasRunning = new Set(activeJobs.filter((j) => j.status === "pendente" || j.status === "processando").map((j) => j.id));
        const stillRunning = fresh.filter((j) => j.status === "pendente" || j.status === "processando").map((j) => j.id);
        setActiveJobs(fresh);
        if ([...wasRunning].some((id) => !stillRunning.includes(id))) router.refresh();
      } catch {
        /* próxima rodada */
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [running, activeJobs, router]);

  const gmailNotice = params.get("gmail") ? { status: params.get("gmail")!, reason: params.get("motivo") } : null;
  const view: CareerSnapshot = { ...data, activeJobs };
  const cfg = data.config;

  return (
    <div className="space-y-4">
      {cfg.demoAuth && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Sessão de demonstração: a autenticação real (Supabase Auth) ainda não está ativa. Armazenamento {cfg.storage === "local" ? "local (.data/career)" : "Supabase"}.
            Não use dados pessoais reais em produção antes de ativar autenticação e RLS.
          </span>
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 sm:w-auto" aria-label="Seções de Carreira">
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
              <t.icon className="size-3.5" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="curriculo"><ResumeTab data={view} /></TabsContent>
        <TabsContent value="analise"><AnalysisTab data={view} /></TabsContent>
        <TabsContent value="vagas"><JobsTab data={view} /></TabsContent>
        <TabsContent value="candidaturas"><ApplicationsTab data={view} gmailNotice={gmailNotice} /></TabsContent>
      </Tabs>
    </div>
  );
}
