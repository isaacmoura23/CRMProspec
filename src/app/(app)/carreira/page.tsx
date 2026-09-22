import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/auth";
import { careerRepo } from "@/services/career/repository";
import { kickWorker } from "@/services/career/queue";
import { getCareerSnapshot, ownerOf } from "@/services/career/service";
import { CareerView } from "@/features/career/career-view";

export const metadata: Metadata = { title: "Carreira" };
export const dynamic = "force-dynamic";
// A página pode acordar o worker da fila (análise, links, envios) via after().
export const maxDuration = 300;

export default async function CarreiraPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const user = await getCurrentUser();
  const owner = ownerOf(user);
  const { aba } = await searchParams;
  const data = await getCareerSnapshot(owner);

  // Sem agendador externo, a navegação é o que dispara jobs vencidos —
  // mesmo padrão da varredura de leads no layout.
  if ((await careerRepo().countDueJobs()) > 0) kickWorker();

  return (
    <div>
      <PageHeader
        title="Carreira"
        description="Envie seu currículo, receba correções com evidências, encontre vagas compatíveis e acompanhe cada candidatura."
      />
      <Suspense>
        <CareerView data={data} initialTab={aba ?? null} />
      </Suspense>
    </div>
  );
}
