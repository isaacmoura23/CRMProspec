import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { normalizeNicheAnalystConfig, normalizeProspectorConfig } from "@/agents/config";
import { SUPPORTED_NICHES } from "@/agents/niche/agent";
import { getAgent } from "@/agents/registry";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth";
import { canAdminister, canWrite } from "@/lib/permissions";
import { AutoRefresh, ModeSelect } from "@/features/agents/controls";
import { MODE_BADGE, MODE_LABEL } from "@/features/agents/labels";
import { NichePanel } from "@/features/agents/niche-panel";
import { DossierList, PresenceConfigForm } from "@/features/presence/presence-panel";
import { getPresencePanel } from "@/services/presence/panel";
import { SiteBuildList, SiteBuilderConfigForm } from "@/features/sites/site-builder-panel";
import { getSiteBuilderPanel } from "@/services/sites/panel";
import { ProspectorPanel } from "@/features/agents/prospector-panel";
import { EventList, TaskList } from "@/features/agents/task-list";
import { getAgentDetail, getRunnerStatus } from "@/services/agents/overview";
import { isAgentId } from "@/types/agents";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: getAgent(id)?.name ?? "Agente" };
}

export default async function AgentePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isAgentId(id)) notFound();
  // O Vendedor tem tela própria (conexão do WhatsApp, política de envio, fila e mensagens).
  if (id === "seller") redirect("/agentes/vendedor");
  const agent = getAgent(id);
  const user = await getCurrentUser();
  const detail = await getAgentDetail(id);
  if (!agent || !detail) notFound();
  const runner = await getRunnerStatus();
  const canAdmin = canAdminister(user.role);
  const canRun = canWrite(user.role);
  const presencePanel = id === "presence" ? await getPresencePanel() : null;
  const sitePanel = id === "site-builder" ? await getSiteBuilderPanel() : null;

  return (
    <div>
      <AutoRefresh />
      <Link href="/agentes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Agentes
      </Link>
      <PageHeader title={agent.name} description={agent.description}>
        <Badge variant={MODE_BADGE[detail.summary.mode]}>{MODE_LABEL[detail.summary.mode]}</Badge>
        <ModeSelect agent={id} mode={detail.summary.mode} canEdit={canAdmin} />
      </PageHeader>

      <div className="space-y-6">
        {id === "niche-analyst" && (
          <NichePanel
            config={normalizeNicheAnalystConfig(detail.config)}
            niches={SUPPORTED_NICHES}
            targets={detail.targets}
            canAdmin={canAdmin}
            canRun={canRun}
            runnerAlive={runner.alive}
          />
        )}
        {id === "prospector" && (
          <ProspectorPanel
            config={normalizeProspectorConfig(detail.config)}
            niches={SUPPORTED_NICHES}
            targets={detail.targets}
            canAdmin={canAdmin}
            canRun={canRun}
            runnerAlive={runner.alive}
          />
        )}

        {sitePanel && (
          <>
            <SiteBuildList data={sitePanel} canRun={canRun} />
            <SiteBuilderConfigForm config={sitePanel.config} browserFound={sitePanel.browserFound} canAdmin={canAdmin} />
          </>
        )}
        {presencePanel && (
          <>
            <DossierList rows={presencePanel.rows} waiting={presencePanel.waiting} doneToday={presencePanel.doneToday} perDay={presencePanel.config.dossiers_per_day} canRun={canRun} />
            <PresenceConfigForm config={presencePanel.config} visual={presencePanel.visual} canAdmin={canAdmin} />
          </>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Tarefas</CardTitle>
              <CardDescription>As 20 mais recentes, com o que cada uma produziu.</CardDescription>
            </CardHeader>
            <TaskList tasks={detail.tasks} canCancel={canRun} />
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Registro</CardTitle>
              <CardDescription>Eventos deste agente.</CardDescription>
            </CardHeader>
            <EventList events={detail.events} />
          </Card>
        </div>
      </div>
    </div>
  );
}
