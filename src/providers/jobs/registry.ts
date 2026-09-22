import "server-only";
import { AdzunaProvider } from "@/providers/jobs/adzuna";
import { DemoJobsProvider } from "@/providers/jobs/demo";
import { RemotiveProvider } from "@/providers/jobs/remotive";
import type { JobProvider } from "@/providers/jobs/types";

/** Provedores disponíveis, na ordem de consulta. */
export function allJobProviders(): JobProvider[] {
  return [new AdzunaProvider(), new RemotiveProvider(), new DemoJobsProvider()];
}

export function activeJobProviders(): JobProvider[] {
  return allJobProviders().filter((p) => p.isConfigured());
}

export function getJobProvider(id: string): JobProvider | null {
  return allJobProviders().find((p) => p.id === id) ?? null;
}

export interface JobSourceStatus {
  id: string;
  name: string;
  coverage: string;
  configured: boolean;
  isDemo: boolean;
  hint: string | null;
}

export function jobSourcesStatus(): JobSourceStatus[] {
  return allJobProviders().map((p) => ({
    id: p.id,
    name: p.name,
    coverage: p.coverage,
    configured: p.isConfigured(),
    isDemo: p.isDemo,
    hint:
      p.id === "adzuna" && !p.isConfigured()
        ? "Defina ADZUNA_APP_ID e ADZUNA_APP_KEY (developer.adzuna.com) e ADZUNA_COUNTRY (padrão br)."
        : p.id === "demo" && !p.isConfigured()
          ? "Defina CAREER_DEMO_JOBS=true para usar fixtures fictícias."
          : null,
  }));
}
