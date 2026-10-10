import type { NicheEvidence, NicheFactor, NicheMetrics } from "@/types/agents";

/**
 * Score de nicho — regras objetivas e explicáveis (0–100), no mesmo espírito
 * de `services/scoring.ts`: cada fator é registrado para o usuário ver "por
 * que este nicho está em 3º?".
 *
 * Pesos publicados:
 *   - Lacuna digital        40  quem não tem site ou tem um fraco é quem compra;
 *   - Mercado ativo         20  empresas com avaliações são negócios que operam;
 *   - Alcançabilidade       20  sem telefone não há como abordar;
 *   - Aderência ao perfil   20  nicho que o dono já escolheu como prioritário.
 * "Tendência de busca" aparece como não avaliada: não há fonte medida ainda, e
 * inventar um número seria pior que declarar a ausência.
 */

export const NICHE_WEIGHTS = {
  gap: 40,
  activity: 20,
  reach: 20,
  fit: 20,
} as const;

export interface NicheScoreInput {
  metrics: NicheMetrics;
  /** Quantas empresas foram pedidas à fonte. */
  sampleRequested: number;
  nicheKey: string;
  nicheLabel: string;
  /** `company_profile.priority_niches`: chaves ou rótulos. */
  priorityNiches: string[];
  /** Só `google_places` representa o mercado real. */
  source: string;
}

export interface NicheScoreResult {
  score: number;
  factors: NicheFactor[];
  evidence: NicheEvidence[];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export function isPriorityNiche(nicheKey: string, nicheLabel: string, priority: string[]): boolean {
  const wanted = new Set(priority.map(norm).filter(Boolean));
  return wanted.has(norm(nicheKey)) || wanted.has(norm(nicheLabel));
}

export function scoreNiche(input: NicheScoreInput): NicheScoreResult {
  const { metrics: m } = input;
  const evidence: NicheEvidence[] = [
    {
      label: "Fonte",
      value: input.source === "google_places" ? "Google Places (dados reais)" : "Diretório de demonstração (dados fictícios)",
    },
    { label: "Amostra", value: `${m.total} empresas (pedidas: ${input.sampleRequested})` },
  ];

  if (m.total === 0) {
    return {
      score: 0,
      factors: [
        { label: "Lacuna digital", points: 0, max: NICHE_WEIGHTS.gap, note: "a fonte não devolveu empresas" },
        { label: "Mercado ativo", points: 0, max: NICHE_WEIGHTS.activity, note: "sem amostra" },
        { label: "Alcançabilidade", points: 0, max: NICHE_WEIGHTS.reach, note: "sem amostra" },
        { label: "Aderência ao seu perfil", points: 0, max: NICHE_WEIGHTS.fit, note: "sem amostra" },
      ],
      evidence,
    };
  }

  /* 1. Lacuna digital: sem site + (com site × taxa de sites fracos medida). */
  const weakRate = m.sites_sampled > 0 ? m.weak_sites / m.sites_sampled : 0;
  const gapRate = (m.no_site + m.with_site * weakRate) / m.total;
  const gapPoints = Math.round(gapRate * NICHE_WEIGHTS.gap);
  const gapNote =
    `${pct(m.no_site, m.total)}% sem site` +
    (m.sites_sampled > 0
      ? `; ${m.weak_sites} de ${m.sites_sampled} sites visitados são fracos`
      : m.with_site > 0
        ? "; qualidade dos sites não foi medida"
        : "");

  /* 2. Mercado ativo: avaliações no Google, penalizado se a amostra é escassa. */
  const activityRate = m.with_reviews / m.total;
  const scarcity = Math.min(1, m.total / Math.max(1, input.sampleRequested * 0.5));
  const activityPoints = Math.round(activityRate * scarcity * NICHE_WEIGHTS.activity);
  const activityNote =
    `${pct(m.with_reviews, m.total)}% com avaliações` +
    (scarcity < 1 ? `; poucas empresas encontradas (${m.total}), nota reduzida` : "");

  /* 3. Alcançabilidade: telefone. */
  const reachPoints = Math.round((m.with_phone / m.total) * NICHE_WEIGHTS.reach);
  const reachNote = `${pct(m.with_phone, m.total)}% com telefone`;

  /* 4. Aderência: o dono marcou este nicho como prioritário? */
  const hasPriorityList = input.priorityNiches.some((n) => n.trim().length > 0);
  let fitPoints: number;
  let fitNote: string;
  if (!hasPriorityList) {
    fitPoints = NICHE_WEIGHTS.fit / 2;
    fitNote = "perfil sem nichos prioritários definidos (neutro)";
  } else if (isPriorityNiche(input.nicheKey, input.nicheLabel, input.priorityNiches)) {
    fitPoints = NICHE_WEIGHTS.fit;
    fitNote = "está entre os nichos prioritários do perfil";
  } else {
    fitPoints = 0;
    fitNote = "fora dos nichos prioritários do perfil";
  }

  const factors: NicheFactor[] = [
    { label: "Lacuna digital", points: gapPoints, max: NICHE_WEIGHTS.gap, note: gapNote },
    { label: "Mercado ativo", points: activityPoints, max: NICHE_WEIGHTS.activity, note: activityNote },
    { label: "Alcançabilidade", points: reachPoints, max: NICHE_WEIGHTS.reach, note: reachNote },
    { label: "Aderência ao seu perfil", points: fitPoints, max: NICHE_WEIGHTS.fit, note: fitNote },
    { label: "Tendência de busca", points: 0, max: 0, note: "não avaliada nesta versão (sem fonte medida)" },
  ];

  evidence.push(
    { label: "Sem site", value: `${m.no_site} de ${m.total}` },
    { label: "Com site", value: `${m.with_site} de ${m.total}` },
    { label: "Sites visitados", value: `${m.sites_sampled} (fracos: ${m.weak_sites})` },
    { label: "Com telefone", value: `${m.with_phone} de ${m.total}` },
    { label: "Com avaliações", value: `${m.with_reviews} de ${m.total}` }
  );

  const score = Math.max(0, Math.min(100, gapPoints + activityPoints + reachPoints + fitPoints));
  return { score, factors, evidence };
}
