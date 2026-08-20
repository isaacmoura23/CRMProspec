import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { statusRank } from "@/services/stats";
import { sourceLabel } from "@/services/lead-service";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";

export const metadata: Metadata = { title: "Relatórios" };
export const dynamic = "force-dynamic";

export default function RelatoriosPage() {
  const db = getDb();
  const leads = db.leads.filter((l) => !l.archived);
  const currency = db.organization.currency;

  /* Prospecção */
  const encontrados = leads.length;
  const qualificados = leads.filter((l) => (l.lead_score ?? 0) >= db.settings.min_score).length;
  const contatados = leads.filter((l) => statusRank(l.status) >= 4 || l.status === "perdido").length;
  const responderam = leads.filter((l) => statusRank(l.status) >= 5).length;
  const taxaResposta = contatados > 0 ? (responderam / contatados) * 100 : 0;

  /* Comercial */
  const reunioes = db.activities.filter((a) => a.type === "reuniao").length;
  const propostas = db.proposals.length;
  const vendas = leads.filter((l) => l.status === "fechado");
  const receita = vendas.reduce((acc, l) => acc + (l.potential_value ?? 0), 0);
  const ticketMedio = vendas.length > 0 ? receita / vendas.length : 0;

  /* Origem */
  const bySource = Object.entries(
    leads.reduce<Record<string, number>>((acc, l) => {
      acc[l.source] = (acc[l.source] ?? 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]);
  const maxSource = Math.max(...bySource.map(([, n]) => n), 1);

  /* Nicho */
  const byNiche = Object.entries(
    leads.reduce<Record<string, { total: number; won: number }>>((acc, l) => {
      acc[l.segment] = acc[l.segment] ?? { total: 0, won: 0 };
      acc[l.segment]!.total += 1;
      if (l.status === "fechado") acc[l.segment]!.won += 1;
      return acc;
    }, {})
  )
    .map(([niche, s]) => ({ niche, ...s, rate: s.total > 0 ? (s.won / s.total) * 100 : 0 }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total);

  /* Vendedor */
  const bySeller = db.users.map((u) => {
    const assigned = leads.filter((l) => l.assigned_to === u.id);
    const acts = db.activities.filter((a) => a.user_id === u.id);
    const contacts = acts.filter((a) => ["primeiro_contato", "mensagem_enviada"].includes(a.type)).length;
    const replies = assigned.filter((l) => statusRank(l.status) >= 5).length;
    const meetings = acts.filter((a) => a.type === "reuniao").length;
    const props = db.proposals.filter((p) => assigned.some((l) => l.id === p.lead_id)).length;
    const won = assigned.filter((l) => l.status === "fechado");
    const rev = won.reduce((acc, l) => acc + (l.potential_value ?? 0), 0);
    return {
      user: u,
      contacts,
      replies,
      meetings,
      proposals: props,
      sales: won.length,
      revenue: rev,
      conversion: assigned.length > 0 ? (won.length / assigned.length) * 100 : 0,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Relatórios" description="Números reais da operação — prospecção, comercial, origem, nicho e vendedor." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Prospecção</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <Stat label="Leads encontrados" value={formatNumber(encontrados)} />
            <Stat label="Qualificados" value={formatNumber(qualificados)} />
            <Stat label="Contatados" value={formatNumber(contatados)} />
            <Stat label="Taxa de resposta" value={formatPercent(taxaResposta)} highlight />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Comercial</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Reuniões" value={formatNumber(reunioes)} />
            <Stat label="Propostas" value={formatNumber(propostas)} />
            <Stat label="Vendas" value={formatNumber(vendas.length)} />
            <Stat label="Ticket médio" value={formatCurrency(ticketMedio, currency)} />
            <Stat label="Receita" value={formatCurrency(receita, currency)} highlight />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Origem dos leads</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {bySource.map(([source, count]) => (
              <div key={source} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-[13px] text-muted-foreground">
                  {sourceLabel(source)}
                </span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-surface-hover">
                  <div
                    className="flex h-full items-center rounded bg-foreground/80 px-1.5"
                    style={{ width: `${Math.max(8, (count / maxSource) * 100)}%` }}
                  >
                    <span className="text-[10px] font-semibold text-white">{count}</span>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversão por nicho</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byNiche.map((n) => (
              <div key={n.niche} className="flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">
                  {n.niche} <span className="text-faint-foreground">({n.total} leads)</span>
                </span>
                <span className={n.rate > 0 ? "font-semibold text-primary" : "text-faint-foreground"}>
                  {formatPercent(n.rate)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Desempenho por vendedor</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Vendedor</TableHead>
                <TableHead>Contatos</TableHead>
                <TableHead>Respostas</TableHead>
                <TableHead>Reuniões</TableHead>
                <TableHead>Propostas</TableHead>
                <TableHead>Vendas</TableHead>
                <TableHead>Receita</TableHead>
                <TableHead>Conversão</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bySeller.map((s) => (
                <TableRow key={s.user.id}>
                  <TableCell className="pl-5 text-[13px] font-medium">{s.user.name}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">{s.contacts}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">{s.replies}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">{s.meetings}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">{s.proposals}</TableCell>
                  <TableCell className="text-[13px] tabular-nums">{s.sales}</TableCell>
                  <TableCell className="text-[13px] font-medium tabular-nums">
                    {formatCurrency(s.revenue, currency)}
                  </TableCell>
                  <TableCell className="text-[13px] font-semibold tabular-nums text-primary">
                    {formatPercent(s.conversion)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-hover px-3 py-2.5">
      <p className={`text-lg font-semibold tabular-nums ${highlight ? "text-primary" : ""}`}>{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
