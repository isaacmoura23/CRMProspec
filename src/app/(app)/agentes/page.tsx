import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/auth";
import { canAdminister } from "@/lib/permissions";
import { AutoRefresh, GlobalSwitch } from "@/features/agents/controls";
import { AgentCards, ApprovalsCallout, FunnelStrip, RecentEvents, RunnerBanner } from "@/features/agents/overview";
import { getAgentsOverview } from "@/services/agents/overview";

export const metadata: Metadata = { title: "Agentes" };
export const dynamic = "force-dynamic";

export default async function AgentesPage() {
  const user = await getCurrentUser();
  const data = await getAgentsOverview();
  const canAdmin = canAdminister(user.role);

  return (
    <div>
      <AutoRefresh />
      <PageHeader
        title="Agentes"
        description="Os agentes trabalham o funil sozinhos; aqui você acompanha, ajusta os limites e aprova o que precisa do seu clique."
      >
        <GlobalSwitch enabled={data.globalEnabled} canEdit={canAdmin} />
      </PageHeader>
      <RunnerBanner data={data} />
      <ApprovalsCallout count={data.approvalsPending} />
      <FunnelStrip data={data} />
      <AgentCards data={data} canAdmin={canAdmin} />
      <RecentEvents data={data} />
    </div>
  );
}
