import "server-only";
import { detectWorkMode, findApplicationEmail, htmlToText } from "@/lib/job-text";
import type { JobProvider, JobSearchQuery, RawJob } from "@/providers/jobs/types";
import { RateLimitedError } from "@/providers/jobs/types";

/**
 * Adzuna — agregador com API documentada (https://developer.adzuna.com/).
 * Requer `ADZUNA_APP_ID` e `ADZUNA_APP_KEY`; `ADZUNA_COUNTRY` escolhe o
 * mercado (padrão `br`; a API cobre também gb, us, pt, es, de, fr, etc.).
 * A descrição vem truncada pela API — o anúncio completo fica no
 * `redirect_url`, e a candidatura é sempre no site de origem.
 */

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  salary_min?: number;
  salary_max?: number;
  contract_type?: string;
  contract_time?: string;
}

const TIMEOUT_MS = 12_000;

export class AdzunaProvider implements JobProvider {
  id = "adzuna";
  name = "Adzuna";
  isDemo = false;
  applyCapability = "link_externo" as const;

  get coverage() {
    return `Agregador de vagas — país configurado: ${(process.env.ADZUNA_COUNTRY ?? "br").toUpperCase()}`;
  }

  isConfigured() {
    return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  }

  async search(query: JobSearchQuery): Promise<{ jobs: RawJob[]; hasMore: boolean }> {
    const country = (process.env.ADZUNA_COUNTRY ?? "br").toLowerCase();
    const page = Math.max(1, query.page ?? 1);
    const perPage = Math.min(query.perPage ?? 30, 50);
    const params = new URLSearchParams({
      app_id: process.env.ADZUNA_APP_ID!,
      app_key: process.env.ADZUNA_APP_KEY!,
      results_per_page: String(perPage),
      what: query.terms.slice(0, 4).join(" "),
      "content-type": "application/json",
    });
    if (query.location) params.set("where", query.location);
    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params.toString()}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) throw new RateLimitedError(120_000);
    if (res.status === 401 || res.status === 403) throw new Error("Adzuna recusou as credenciais (ADZUNA_APP_ID/APP_KEY).");
    if (!res.ok) throw new Error(`Adzuna respondeu ${res.status}`);
    const data = (await res.json()) as { results?: AdzunaJob[]; count?: number };
    const results = data.results ?? [];
    const evidenceUrl = url.replace(/app_key=[^&]+/, "app_key=***");
    const jobs = results.map((j): RawJob => {
      const description = htmlToText(j.description ?? "");
      const email = findApplicationEmail(description);
      const salary = j.salary_min || j.salary_max ? `${j.salary_min ?? "?"} – ${j.salary_max ?? "?"}` : null;
      return {
        source: this.id,
        external_id: String(j.id),
        title: j.title,
        company: j.company?.display_name ?? "Empresa não informada",
        description,
        location: j.location?.display_name ?? null,
        work_mode: detectWorkMode(`${j.title} ${description}`),
        url: j.redirect_url,
        apply_url: j.redirect_url,
        application_email: email?.email ?? null,
        application_email_evidence: email?.evidence ?? null,
        salary,
        contract_type: [j.contract_type, j.contract_time].filter(Boolean).join(" / ") || null,
        posted_at: j.created ? new Date(j.created).toISOString() : null,
        expires_at: null,
        origin_evidence: evidenceUrl,
      };
    });
    return { jobs, hasMore: (data.count ?? 0) > page * perPage };
  }

  async checkAvailability(_externalId: string, url: string): Promise<boolean | null> {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000) });
      if (res.status === 404 || res.status === 410) return false;
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }
}
