import "server-only";
import type { JobProvider, JobSearchQuery, RawJob } from "@/providers/jobs/types";

/**
 * Fixtures de demonstração. Só entram quando `CAREER_DEMO_JOBS=true`, e
 * todo anúncio vem marcado com `source: "demo"` e domínio reservado
 * (example.com), então nenhum envio real pode acontecer a partir deles.
 */

const FIXTURES: Array<Omit<RawJob, "source" | "origin_evidence">> = [
  {
    external_id: "demo-1",
    title: "Desenvolvedor(a) Front-end Pleno",
    company: "Loja Exemplo",
    description:
      "Buscamos pessoa desenvolvedora front-end para o time de e-commerce.\nRequisitos:\n• React e TypeScript\n• Consumo de APIs REST\n• Git\nDesejável:\n• Next.js\n• Testes automatizados\nComo se candidatar: envie seu currículo para vagas@example.com com o assunto Front-end.",
    location: "São Paulo, SP",
    work_mode: "hibrido",
    url: "https://example.com/vagas/frontend-pleno",
    apply_url: "https://example.com/vagas/frontend-pleno",
    application_email: "vagas@example.com",
    application_email_evidence: "Como se candidatar: envie seu currículo para vagas@example.com com o assunto Front-end.",
    salary: null,
    contract_type: "CLT",
    posted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    expires_at: null,
  },
  {
    external_id: "demo-2",
    title: "Analista de Marketing Digital",
    company: "Agência Modelo",
    description:
      "Responsabilidades:\n• Planejar campanhas em Google Ads e Meta Ads\n• Acompanhar métricas e relatórios\nRequisitos:\n• Experiência com mídia paga\n• Excel ou Google Sheets\n• Comunicação escrita\nDiferenciais:\n• SEO\n• Power BI",
    location: "Remoto",
    work_mode: "remoto",
    url: "https://example.com/vagas/marketing-digital",
    apply_url: "https://example.com/vagas/marketing-digital",
    application_email: null,
    application_email_evidence: null,
    salary: "R$ 4.000 – 5.500",
    contract_type: "PJ",
    posted_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    expires_at: null,
  },
  {
    external_id: "demo-3",
    title: "Backend Engineer (Node.js)",
    company: "Example Labs",
    description:
      "Requirements:\n• Node.js and TypeScript\n• PostgreSQL\n• Docker\n• English (working proficiency)\nNice to have:\n• AWS\n• Kubernetes\nApply by sending your resume to jobs@example.com.",
    location: "Remote",
    work_mode: "remoto",
    url: "https://example.com/jobs/backend-node",
    apply_url: "https://example.com/jobs/backend-node",
    application_email: "jobs@example.com",
    application_email_evidence: "Apply by sending your resume to jobs@example.com.",
    salary: null,
    contract_type: "Full-time",
    posted_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    expires_at: null,
  },
];

export class DemoJobsProvider implements JobProvider {
  id = "demo";
  name = "Vagas de demonstração";
  coverage = "Fixtures fictícias (example.com) — não são vagas reais";
  isDemo = true;
  applyCapability = "email_publicado" as const;

  isConfigured() {
    return process.env.CAREER_DEMO_JOBS === "true";
  }

  async search(query: JobSearchQuery): Promise<{ jobs: RawJob[]; hasMore: boolean }> {
    const terms = query.terms.map((t) => t.toLowerCase());
    const jobs = FIXTURES.filter((f) => terms.length === 0 || terms.some((t) => `${f.title} ${f.description}`.toLowerCase().includes(t))).map(
      (f): RawJob => ({ ...f, source: this.id, origin_evidence: "fixture de demonstração" })
    );
    return { jobs, hasMore: false };
  }

  async checkAvailability(): Promise<boolean | null> {
    return true;
  }
}
