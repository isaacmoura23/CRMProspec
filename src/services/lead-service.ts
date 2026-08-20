import "server-only";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { computeScore } from "@/services/scoring";
import { STATUS_LABEL } from "@/services/stats";
import { STAGE_IDS } from "@/lib/seed";
import type { Activity, ActivityType, Lead, LeadStatus, RawLead } from "@/types";
import { contactNameMaybe } from "@/providers/directory-provider";

/** Converte dado bruto de um provider em Lead persistido */
export function createLeadFromRaw(raw: RawLead, campaignId: string | null, userId: string | null): Lead {
  const db = getDb();
  const now = nowIso();

  const partial = {
    has_website: Boolean(raw.website),
    website_quality: raw.website_quality ?? (raw.website ? "desconhecido" : "nenhum"),
    instagram: raw.instagram ?? null,
    instagram_active: raw.instagram_active ?? false,
    phone: raw.phone ?? null,
    whatsapp: raw.whatsapp ?? null,
    has_whatsapp: Boolean(raw.whatsapp),
    email: raw.email ?? null,
    business_active: raw.business_active ?? true,
    catalog_size: raw.catalog_size ?? "desconhecido",
    marketing_signals: raw.marketing_signals ?? false,
    reviews_count: raw.reviews_count ?? null,
    rating: raw.rating ?? null,
  } as const;

  const { score, classification, factors } = computeScore(partial);

  const lead: Lead = {
    id: uid("lead"),
    organization_id: db.organization.id,
    company_name: raw.company_name,
    contact_name: contactNameMaybe(),
    legal_name: null,
    segment: raw.segment,
    description: raw.description ?? null,
    ...partial,
    facebook: raw.facebook ?? null,
    linkedin: null,
    website: raw.website ?? null,
    google_maps_url:
      raw.google_maps_url ??
      (raw.source === "google_places"
        ? `https://maps.google.com/?q=${encodeURIComponent(raw.company_name)}`
        : null),
    country: raw.country,
    state: raw.state ?? null,
    city: raw.city,
    address: raw.address ?? null,
    opening_hours: raw.opening_hours ?? null,
    source: raw.source,
    source_id: raw.source_id ?? null,
    campaign_id: campaignId,
    status: "novo",
    pipeline_stage_id: STAGE_IDS.novo,
    stage_entered_at: now,
    lead_score: score,
    temperature: classification,
    potential_value: null,
    assigned_to: userId,
    archived: false,
    created_at: now,
    updated_at: now,
    last_contact_at: null,
    next_follow_up_at: null,
  };

  db.leads.push(lead);
  db.lead_score_history.push({
    id: uid("sch"),
    lead_id: lead.id,
    score,
    classification,
    factors,
    created_at: now,
  });
  logActivity(lead.id, "lead_criado", `Lead encontrado via ${sourceLabel(raw.source)}`, userId);
  saveDb();
  return lead;
}

export function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    google_places: "Google Places",
    diretorio: "diretório empresarial",
    csv: "importação CSV",
    manual: "cadastro manual",
    webhook: "webhook",
    demo: "dados de demonstração",
  };
  return map[source] ?? source;
}

export function logActivity(
  leadId: string,
  type: ActivityType,
  description: string,
  userId: string | null
): Activity {
  const db = getDb();
  const activity: Activity = {
    id: uid("act"),
    organization_id: db.organization.id,
    lead_id: leadId,
    type,
    description,
    user_id: userId,
    created_at: nowIso(),
  };
  db.activities.push(activity);
  return activity;
}

export function recomputeLeadScore(leadId: string): void {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return;
  const { score, classification, factors } = computeScore(lead);
  lead.lead_score = score;
  lead.temperature = classification;
  lead.updated_at = nowIso();
  db.lead_score_history.push({
    id: uid("sch"),
    lead_id: lead.id,
    score,
    classification,
    factors,
    created_at: nowIso(),
  });
  logActivity(lead.id, "score_atualizado", `Score calculado: ${score} (${classification})`, null);
  saveDb();
}

const STATUS_TO_STAGE: Record<LeadStatus, string> = {
  novo: STAGE_IDS.novo,
  analisado: STAGE_IDS.analisado,
  qualificado: STAGE_IDS.qualificado,
  pronto_contato: STAGE_IDS.pronto,
  contatado: STAGE_IDS.contatado,
  respondeu: STAGE_IDS.respondeu,
  interessado: STAGE_IDS.interessado,
  demo: STAGE_IDS.demo,
  reuniao: STAGE_IDS.reuniao,
  proposta: STAGE_IDS.proposta,
  negociacao: STAGE_IDS.negociacao,
  fechado: STAGE_IDS.fechado,
  perdido: STAGE_IDS.perdido,
};

const STAGE_TO_STATUS: Record<string, LeadStatus> = Object.fromEntries(
  Object.entries(STATUS_TO_STAGE).map(([status, stage]) => [stage, status as LeadStatus])
) as Record<string, LeadStatus>;

export function setLeadStatus(leadId: string, status: LeadStatus, userId: string | null): void {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead || lead.status === status) return;
  lead.status = status;
  lead.pipeline_stage_id = STATUS_TO_STAGE[status];
  lead.stage_entered_at = nowIso();
  lead.updated_at = nowIso();
  logActivity(leadId, "status_alterado", `Status alterado para ${STATUS_LABEL[status]}`, userId);
  saveDb();
}

export function setLeadStage(leadId: string, stageId: string, userId: string | null): void {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  const stage = db.pipeline_stages.find((s) => s.id === stageId);
  if (!lead || !stage || lead.pipeline_stage_id === stageId) return;
  lead.pipeline_stage_id = stageId;
  lead.stage_entered_at = nowIso();
  lead.updated_at = nowIso();
  const mapped = STAGE_TO_STATUS[stageId];
  if (mapped) lead.status = mapped;
  logActivity(leadId, "etapa_alterada", `Movido para ${stage.name}`, userId);

  // Conversão automática: fechado vira cliente e mantém histórico
  if (stage.is_won) {
    logActivity(leadId, "fechamento", `Negócio fechado — ${lead.company_name} agora é cliente`, userId);
  }
  saveDb();
}
