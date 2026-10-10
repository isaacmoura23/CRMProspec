import type { Metadata } from "next";
import Link from "next/link";
import { Download, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber, timeAgo } from "@/lib/format";
import { instagramUrl } from "@/lib/utils";
import { coverageSummary, prospectRows, safeHttpUrl } from "@/services/prospecting/list";

export const metadata: Metadata = { title: "Lista de prospecção" };
export const dynamic = "force-dynamic";

export default async function ProspeccaoPage() {
  const rows = prospectRows();
  const coverage = await coverageSummary();
  const real = rows.filter((r) => !r.demo);
  const withPhone = rows.filter((r) => r.phone).length;
  const withInstagram = rows.filter((r) => r.instagram).length;

  return (
    <div>
      <PageHeader
        title="Lista de prospecção"
        description="Empresas sem site que o Prospectador encontrou: nome, telefone, Instagram e a ficha no Google Maps. O Instagram só aparece quando foi encontrado."
      >
        <a href="/api/prospeccao/csv" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium hover:bg-surface-hover">
          <Download className="size-4" /> Exportar CSV
        </a>
      </PageHeader>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Empresas sem site", formatNumber(rows.length), `${formatNumber(real.length)} reais · ${formatNumber(rows.length - real.length)} de demonstração`],
          ["Com telefone", formatNumber(withPhone), "Dá para abordar"],
          ["Com Instagram", formatNumber(withInstagram), "Só quando a ficha ou o cadastro traz"],
          ["Cidades varridas", `${formatNumber(coverage.citiesSwept)} de ${formatNumber(coverage.citiesInScope)}`, coverage.sweepOn ? "Varredura contínua ligada" : "Varredura contínua desligada"],
        ].map(([label, value, hint]) => (
          <Card key={label}>
            <CardContent className="space-y-1 p-4">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="text-2xl font-semibold tabular-nums">{value}</p>
              <p className="text-xs text-faint-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Empresas</CardTitle>
          <CardDescription>As mais novas primeiro. A ficha do Maps abre numa nova aba.</CardDescription>
        </CardHeader>
        {rows.length === 0 ? (
          <CardContent>
            <p className="text-[13px] text-muted-foreground">
              Nenhuma empresa sem site ainda. Ligue a varredura em <Link href="/agentes/prospector" className="font-medium text-primary hover:underline">Prospectador</Link> ou prospecte um nicho agora.
            </p>
          </CardContent>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="border-y border-border bg-surface-hover text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-2 font-medium">Empresa</th>
                  <th className="px-3 py-2 font-medium">Telefone</th>
                  <th className="px-3 py-2 font-medium">Instagram</th>
                  <th className="px-3 py-2 font-medium">Google Maps</th>
                  <th className="px-3 py-2 font-medium">Nicho · cidade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.slice(0, 300).map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-2.5">
                      <Link href={`/leads/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      {r.demo && <Badge variant="outline" className="ml-2">demonstração</Badge>}
                      <p className="text-xs text-muted-foreground" title={formatDateTime(r.found_at)}>
                        {timeAgo(r.found_at)}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{r.phone ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {r.instagram && instagramUrl(r.instagram) ? (
                        <a href={instagramUrl(r.instagram)!} target="_blank" rel="noopener noreferrer" title={r.instagram_origin ?? undefined} className="text-primary hover:underline">
                          {r.instagram}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {safeHttpUrl(r.maps_url) ? (
                        <a href={safeHttpUrl(r.maps_url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                          Abrir no Maps <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {r.niche} · {r.city}
                      {r.state ? `/${r.state}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cobertura da varredura</CardTitle>
          <CardDescription>
            O que já foi varrido, por nicho e cidade. Cada busca ao Google é paga e entrega poucas dezenas de empresas, então a varredura é gradual e respeita os tetos diários.{" "}
            {formatNumber(coverage.cells)} combinações varridas · {formatNumber(coverage.found)} empresas novas · {formatNumber(coverage.requests)} requisições ao Google.
          </CardDescription>
        </CardHeader>
        {coverage.cells === 0 ? (
          <CardContent>
            <p className="text-[13px] text-muted-foreground">Nada varrido ainda.</p>
          </CardContent>
        ) : (
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Por nicho</h4>
              <ul className="space-y-1 text-[13px]">
                {coverage.byNiche.map((n) => (
                  <li key={n.niche} className="flex justify-between gap-3">
                    <span>{n.label}</span>
                    <span className="text-muted-foreground">
                      {formatNumber(n.cities)} cidade(s) · {formatNumber(n.found)} empresa(s)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Últimas varreduras</h4>
              <ul className="space-y-1 text-[13px]">
                {coverage.recent.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3">
                    <span>
                      {c.niche_label} · {c.city}
                      {c.state ? `/${c.state}` : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {formatNumber(c.found)} nova(s) · {timeAgo(c.last_run_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
