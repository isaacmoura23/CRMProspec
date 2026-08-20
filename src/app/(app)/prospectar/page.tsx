import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ProspectForm } from "@/features/prospecting/prospect-form";
import { getActiveProvider } from "@/providers/registry";

export const metadata: Metadata = { title: "Prospectar" };
export const dynamic = "force-dynamic";
// server actions desta página (job de prospecção com enriquecimento real)
// precisam de mais tempo que o default do serverless
export const maxDuration = 300;

export default function ProspectarPage() {
  const provider = getActiveProvider();
  return (
    <div>
      <PageHeader
        title="Prospectar"
        description="Configure a busca e deixe o sistema encontrar, enriquecer, analisar e pontuar as oportunidades."
      />
      <ProspectForm providerName={provider.name} />
    </div>
  );
}
