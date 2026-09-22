import "server-only";
import { detectWorkMode, findApplicationEmail, htmlToText } from "@/lib/job-text";
import type { JobProvider, JobSearchQuery, RawJob } from "@/providers/jobs/types";
import { RateLimitedError } from "@/providers/jobs/types";

/**
 * Remotive — API pública de vagas remotas.
 * Documentação: https://remotive.com/api/remote-jobs (sem chave).
 * Cobertura: vagas remotas, majoritariamente em inglês e voltadas a
 * tecnologia/marketing/suporte. Não há API de candidatura: cada anúncio
 * leva ao link externo da empresa.
 */

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

const TIMEOUT_MS = 12_000;

export class RemotiveProvider implements JobProvider {
  id = "remotive";
  name = "Remotive";
  coverage = "Vagas remotas (mundial, principalmente em inglês)";
  isDemo = false;
  applyCapability = "link_externo" as const;

  isConfigured() {
    return process.env.CAREER_DISABLE_REMOTIVE !== "true";
  }

  async search(query: JobSearchQuery): Promise<{ jobs: RawJob[]; hasMore: boolean }> {
    const term = query.terms.slice(0, 3).join(" ").trim();
    const limit = Math.min(query.perPage ?? 30, 60);
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=${limit}`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ProspecAtlas-Career/1" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) throw new RateLimitedError(60_000);
    if (!res.ok) throw new Error(`Remotive respondeu ${res.status}`);
    const data = (await res.json()) as { jobs?: RemotiveJob[] };
    const jobs = (data.jobs ?? []).map((j): RawJob => {
      const description = htmlToText(j.description ?? "").slice(0, 12_000);
      const email = findApplicationEmail(description);
      return {
        source: this.id,
        external_id: String(j.id),
        title: j.title,
        company: j.company_name,
        description,
        location: j.candidate_required_location || null,
        work_mode: detectWorkMode(`${j.title} ${j.candidate_required_location}`) ?? "remoto",
        url: j.url,
        apply_url: j.url,
        application_email: email?.email ?? null,
        application_email_evidence: email?.evidence ?? null,
        salary: j.salary || null,
        contract_type: j.job_type || null,
        posted_at: j.publication_date ? new Date(j.publication_date).toISOString() : null,
        expires_at: null,
        origin_evidence: url,
      };
    });
    return { jobs, hasMore: false };
  }

  async checkAvailability(_externalId: string, url: string): Promise<boolean | null> {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8_000) });
      if (res.status === 404 || res.status === 410) return false;
      if (res.ok) return true;
      return null;
    } catch {
      return null;
    }
  }
}
