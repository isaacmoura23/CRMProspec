import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/auth";
import { canAdminister } from "@/lib/permissions";
import { ApprovalsView } from "@/features/agents/approvals-view";
import { AutoRefresh } from "@/features/agents/controls";
import { expireApprovals } from "@/services/agents/approvals";
import { listApprovals } from "@/services/agents/overview";

export const metadata: Metadata = { title: "Aprovação" };
export const dynamic = "force-dynamic";

export default async function AprovacaoPage() {
  const user = await getCurrentUser();
  // Pedidos vencidos saem da fila antes de a lista ser montada.
  await expireApprovals();
  const { pending, history } = await listApprovals();

  return (
    <div>
      <AutoRefresh />
      <Link href="/agentes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Agentes
      </Link>
      <PageHeader title="Aprovação" description="Tudo que um agente quer iniciar e depende do seu clique." />
      <ApprovalsView pending={pending} history={history} canDecide={canAdminister(user.role)} />
    </div>
  );
}
