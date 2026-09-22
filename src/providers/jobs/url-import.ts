import "server-only";
import { detectWorkMode, findApplicationEmail, htmlToText } from "@/lib/job-text";
import { canonicalUrl } from "@/lib/safe-url";
import { safeFetch } from "@/services/career/safe-fetch";
import type { RawJob } from "@/providers/jobs/types";

/**
 * Importação de uma vaga a partir da URL do anúncio.
 *
 * Usa o cliente HTTP seguro (SSRF) e prioriza o JSON-LD `JobPosting`, que a
 * maioria dos portais publica para o Google Jobs. Sem JSON-LD, cai em
 * título/descrição da página — e o registro deixa claro o que foi lido.
 */

interface JsonLdJobPosting {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  hiringOrganization?: { name?: string } | string;
  jobLocation?: Array<{ address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } }> | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
  jobLocationType?: string;
  applicantLocationRequirements?: unknown;
  baseSalary?: { value?: { minValue?: number; maxValue?: number; value?: number; unitText?: string }; currency?: string };
  directApply?: boolean;
  url?: string;
}

function decode(s: string | undefined): string {
  return htmlToText(s ?? "");
}

function findJobPosting(html: string): JsonLdJobPosting | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1]!.trim()) as unknown;
      const nodes: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const obj = node as JsonLdJobPosting & { "@graph"?: JsonLdJobPosting[] };
        const candidates = obj["@graph"] ? obj["@graph"] : [obj];
        for (const c of candidates) {
          const type = c["@type"];
          if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return c;
        }
      }
    } catch {
      /* JSON-LD malformado: ignora */
    }
  }
  return null;
}

function locationOf(job: JsonLdJobPosting): string | null {
  const loc = Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation;
  const a = loc?.address;
  if (!a) return job.jobLocationType === "TELECOMMUTE" ? "Remoto" : null;
  return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ") || null;
}

export async function importJobFromUrl(rawUrl: string): Promise<{ job: RawJob } | { error: string }> {
  const res = await safeFetch(rawUrl, { maxBytes: 1_500_000, timeoutMs: 12_000 });
  if (!res.ok) {
    return { error: res.error ? `Não foi possível ler a página: ${res.error}` : `A página respondeu ${res.status}` };
  }
  if (!(res.contentType ?? "").includes("html")) return { error: "O endereço não é uma página HTML." };

  const html = res.body;
  const ld = findJobPosting(html);
  const title = ld?.title ?? /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  if (!title) return { error: "Não foi possível identificar o título da vaga na página." };

  const description = ld?.description ? decode(ld.description) : htmlToText(html).slice(0, 15_000);
  const org = ld?.hiringOrganization;
  const company = (typeof org === "string" ? org : org?.name) ?? /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? new URL(res.finalUrl).hostname;
  const email = findApplicationEmail(description) ?? findApplicationEmail(htmlToText(html.replace(/mailto:/g, " ")));
  const mailto = /href=["']mailto:([^"'?]+)/i.exec(html)?.[1] ?? null;
  const salary = ld?.baseSalary?.value ? `${ld.baseSalary.currency ?? ""} ${ld.baseSalary.value.minValue ?? ld.baseSalary.value.value ?? "?"}${ld.baseSalary.value.maxValue ? ` – ${ld.baseSalary.value.maxValue}` : ""} ${ld.baseSalary.value.unitText ?? ""}`.trim() : null;
  const employment = Array.isArray(ld?.employmentType) ? ld!.employmentType.join(" / ") : ld?.employmentType ?? null;

  const job: RawJob = {
    source: "url_import",
    external_id: canonicalUrl(res.finalUrl),
    title: decode(title).slice(0, 200),
    company: decode(company).slice(0, 120),
    description,
    location: ld ? locationOf(ld) : null,
    work_mode: ld?.jobLocationType === "TELECOMMUTE" ? "remoto" : detectWorkMode(`${title} ${description}`),
    url: res.finalUrl,
    apply_url: res.finalUrl,
    application_email: email?.email ?? null,
    application_email_evidence: email?.evidence ?? (mailto ? `mailto: encontrado na página (${mailto}) — confirme se é o destino de candidatura` : null),
    salary,
    contract_type: employment,
    posted_at: ld?.datePosted ? new Date(ld.datePosted).toISOString() : null,
    expires_at: ld?.validThrough ? new Date(ld.validThrough).toISOString() : null,
    origin_evidence: ld ? `JSON-LD JobPosting em ${res.finalUrl}` : `HTML de ${res.finalUrl} (sem JSON-LD; título/descrição da página)`,
  };
  return { job };
}
