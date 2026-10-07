import type { Metadata } from "next";
import Link from "next/link";
import { Compass, Target } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { LeadsTable, type LeadRow } from "@/features/leads/leads-table";
import { NewLeadDialog } from "@/features/leads/new-lead-dialog";
import { ImportCsvDialog } from "@/features/leads/import-csv-dialog";
import { DemoDataNotice } from "@/features/leads/demo-data-notice";
import { buildNextAction } from "@/features/leads/next-action";
import { STATUS_LABEL } from "@/services/stats";
import { countDemoLeads, hideDemoLeads, visibleLeads } from "@/services/lead-visibility";
import type { Lead, LeadStatus } from "@/types";

export const metadata: Metadata = { title: "Leads" };
export const dynamic = "force-dynamic";

interface Params {
  ordenar?: string;
  dir?: string;
  status?: string;
  temperatura?: string;
  /** `?demo=1` traz de volta os leads de demonstração, ocultos por padrão. */
  demo?: string;
}

/** Score a partir do qual o dashboard trata o lead como "quente". */
const HOT_SCORE = 80;
const HOT_STATUSES: LeadStatus[] = ["novo", "analisado", "qualificado", "pronto_contato"];

interface ActiveFilter {
  label: string;
  match: (lead: Lead) => boolean;
}

/**
 * O dashboard já linkava para `/leads?status=...` e `/leads?temperatura=quente`,
 * mas a página só lia `ordenar`/`dir` — clicar em "2 leads prontos para
 * abordagem" abria a lista inteira, sem filtro e sem aviso.
 */
function activeFilter(p: Params): ActiveFilter | null {
  if (p.temperatura === "quente") {
    return {
      label: `Score ${HOT_SCORE}+ ainda não contatados`,
      match: (l) => (l.lead_score ?? 0) >= HOT_SCORE && HOT_STATUSES.includes(l.status),
    };
  }

  if (p.status) {
    // Valores desconhecidos são descartados: uma URL editada à mão não deve
    // devolver uma lista vazia sem explicação.
    const wanted = p.status
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is LeadStatus => s in STATUS_LABEL);
    if (wanted.length === 0) return null;
    return {
      label: wanted.map((s) => STATUS_LABEL[s]).join(" ou "),
      match: (l) => wanted.includes(l.status),
    };
  }

  return null;
}

function applySort(leads: Lead[], p: Params): Lead[] {
  const dir = p.dir === "asc" ? 1 : -1;
  const key = p.ordenar ?? "score";
  return [...leads].sort((a, b) => {
    switch (key) {
      case "empresa":
        return a.company_name.localeCompare(b.company_name) * dir;
      case "contato":
        return ((a.last_contact_at ?? "").localeCompare(b.last_contact_at ?? "")) * dir;
      case "criado":
        return a.created_at.localeCompare(b.created_at) * dir;
      case "score":
      default:
        return ((a.lead_score ?? -1) - (b.lead_score ?? -1)) * dir;
    }
  });
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const db = getDb();

  // Todas as origens entram na lista: prospecção, cadastro manual e import
  // CSV. Filtrar por origem deixava a página permanentemente vazia mesmo
  // depois de criar um lead pelos botões que ficam nela mesma.
  // Com leads reais na base, os de demonstração saem da frente: eles têm
  // score alto e, como a lista ordena por score, ocupavam as primeiras
  // linhas para sempre.
  const mostrarDemo = params.demo === "1";
  const active = visibleLeads(db.leads, mostrarDemo).filter((l) => !l.archived);
  const filter = activeFilter(params);
  const visible = filter ? active.filter(filter.match) : active;
  const sorted = applySort(visible, params);

  const rows: LeadRow[] = sorted.map((lead) => {
    const analysis = db.lead_analysis.find((a) => a.lead_id === lead.id);
    return {
      ...lead,
      problem: analysis?.main_problem ?? null,
      next_action: buildNextAction(lead, db.tasks, analysis),
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Leads"
        description="Suas oportunidades — prospectadas, importadas ou cadastradas — já enriquecidas e pontuadas."
      >
        <ImportCsvDialog />
        <NewLeadDialog />
        <Button asChild>
          <Link href="/prospectar">
            <Compass /> Prospectar
          </Link>
        </Button>
      </PageHeader>

      {filter && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Filtrando por</span>
          <span className="rounded-lg border border-border bg-surface px-2.5 py-1 font-medium">
            {filter.label}
          </span>
          <Link href="/leads" className="text-primary hover:underline">
            Limpar filtro
          </Link>
        </div>
      )}

      {hideDemoLeads(db.leads) && (
        <DemoDataNotice demoCount={countDemoLeads(db.leads)} mostrando={mostrarDemo} />
      )}

      {rows.length === 0 ? (
        filter ? (
          <EmptyState
            icon={Target}
            title="Nenhum lead neste filtro"
            description="Os leads existem, mas nenhum se encaixa no filtro atual. Limpe o filtro para ver a lista completa."
          >
            <Button variant="secondary" asChild>
              <Link href="/leads">Ver todos os leads</Link>
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={Target}
            title="Nenhum lead ainda"
            description="Use a prospecção para encontrar empresas que combinam exatamente com os filtros que você escolher — ou cadastre e importe leads que você já tem."
          >
            <Button asChild>
              <Link href="/prospectar">
                <Compass /> Encontrar leads
              </Link>
            </Button>
          </EmptyState>
        )
      ) : (
        <LeadsTable leads={rows} users={db.users} campaigns={db.campaigns} />
      )}
    </div>
  );
}
