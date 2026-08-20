import type { Lead, ScoreFactor, Temperature } from "@/types";

/**
 * Motor de Lead Score — regras objetivas e explicáveis (0–100).
 * Cada fator é registrado para que o usuário sempre veja
 * "por que esse lead recebeu N pontos".
 */

const BASE_SCORE = 30;

export interface ScoreResult {
  score: number;
  classification: Temperature;
  factors: ScoreFactor[];
}

export function classify(score: number): Temperature {
  if (score >= 80) return "quente";
  if (score >= 60) return "bom";
  if (score >= 40) return "medio";
  return "frio";
}

export function temperatureLabel(t: Temperature | null): string {
  switch (t) {
    case "quente":
      return "Quente";
    case "bom":
      return "Bom";
    case "medio":
      return "Médio";
    case "frio":
      return "Frio";
    default:
      return "—";
  }
}

export function computeScore(lead: Pick<
  Lead,
  | "has_website"
  | "website_quality"
  | "instagram"
  | "instagram_active"
  | "phone"
  | "whatsapp"
  | "email"
  | "business_active"
  | "catalog_size"
  | "marketing_signals"
  | "reviews_count"
  | "rating"
>): ScoreResult {
  const factors: ScoreFactor[] = [{ label: "Base", points: BASE_SCORE }];

  if (!lead.has_website) {
    factors.push({ label: "Não possui site", points: 20 });
  } else if (lead.website_quality === "ruim") {
    factors.push({ label: "Site com problemas visíveis", points: 20 });
  } else if (lead.website_quality === "desatualizado") {
    factors.push({ label: "Site desatualizado", points: 15 });
  } else if (lead.website_quality === "bom") {
    factors.push({ label: "Possui site profissional", points: -25 });
  }

  if (lead.instagram && lead.instagram_active) {
    factors.push({ label: "Instagram ativo", points: 10 });
  }
  if (lead.phone) {
    factors.push({ label: "Telefone encontrado", points: 5 });
  }
  if (lead.whatsapp) {
    factors.push({ label: "WhatsApp encontrado", points: 5 });
  }
  if (lead.business_active) {
    factors.push({ label: "Empresa ativa", points: 10 });
  }
  if (lead.catalog_size === "medio" || lead.catalog_size === "grande") {
    factors.push({ label: "Catálogo/estoque considerável", points: 10 });
  }
  if (lead.marketing_signals) {
    factors.push({ label: "Sinais de investimento em marketing", points: 10 });
  }
  if ((lead.reviews_count ?? 0) >= 20 && (lead.rating ?? 0) >= 4) {
    factors.push({ label: "Bem avaliada no Google", points: 5 });
  }

  const raw = factors.reduce((acc, f) => acc + f.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  return { score, classification: classify(score), factors };
}
