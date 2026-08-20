"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { createLeadFromRaw, logActivity, recomputeLeadScore, setLeadStage, setLeadStatus } from "@/services/lead-service";
import { findDuplicate } from "@/services/dedupe";
import { analyzeAndStore } from "@/jobs/prospecting";
import type { Lead, LeadStatus, RawLead } from "@/types";

const manualLeadSchema = z.object({
  company_name: z.string().min(2).max(120),
  contact_name: z.string().max(120).optional(),
  segment: z.string().min(2).max(60),
  phone: z.string().max(30).optional(),
  whatsapp: z.string().max(30).optional(),
  email: z.string().email().optional().or(z.literal("")),
  website: z.string().max(200).optional(),
  instagram: z.string().max(80).optional(),
  country: z.string().min(2).max(60),
  state: z.string().max(60).optional(),
  city: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
});

export type ManualLeadInput = z.infer<typeof manualLeadSchema>;

export async function createLeadManual(
  input: ManualLeadInput,
  options?: { force?: boolean }
): Promise<{ id: string } | { duplicate: { id: string; company: string; reason: string } } | { error: string }> {
  const parsed = manualLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Dados inválidos. Verifique os campos obrigatórios (empresa, nicho, cidade)." };
  }
  const d = parsed.data;
  const db = getDb();
  const user = await getCurrentUser();

  const raw: RawLead = {
    company_name: d.company_name,
    segment: d.segment,
    description: d.description || undefined,
    phone: d.phone || undefined,
    whatsapp: d.whatsapp || undefined,
    email: d.email || undefined,
    website: d.website || undefined,
    instagram: d.instagram ? (d.instagram.startsWith("@") ? d.instagram : `@${d.instagram}`) : undefined,
    country: d.country,
    state: d.state || undefined,
    city: d.city,
    source: "manual",
    website_quality: d.website ? "desconhecido" : "nenhum",
    instagram_active: Boolean(d.instagram),
    business_active: true,
  };

  if (!options?.force) {
    const dup = findDuplicate(raw, db.leads);
    if (dup) {
      return {
        duplicate: { id: dup.lead.id, company: dup.lead.company_name, reason: dup.reason },
      };
    }
  }

  const lead = createLeadFromRaw(raw, null, user.id);
  if (d.contact_name) {
    lead.contact_name = d.contact_name;
    saveDb();
  }
  revalidatePath("/leads");
  return { id: lead.id };
}

export async function updateLeadField(
  leadId: string,
  patch: Partial<
    Pick<
      Lead,
      | "company_name"
      | "contact_name"
      | "segment"
      | "phone"
      | "whatsapp"
      | "email"
      | "website"
      | "instagram"
      | "city"
      | "state"
      | "country"
      | "description"
      | "potential_value"
      | "assigned_to"
      | "next_follow_up_at"
    >
  >
): Promise<void> {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return;
  Object.assign(lead, patch, { updated_at: nowIso() });
  saveDb();
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

export async function changeLeadStatus(leadId: string, status: LeadStatus): Promise<void> {
  const user = await getCurrentUser();
  setLeadStatus(leadId, status, user.id);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
}

export async function changeLeadStage(leadId: string, stageId: string): Promise<void> {
  const user = await getCurrentUser();
  setLeadStage(leadId, stageId, user.id);
  revalidatePath("/pipeline");
  revalidatePath(`/leads/${leadId}`);
}

export async function analyzeLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead) return { ok: false, error: "Lead não encontrado." };
  const user = await getCurrentUser();
  try {
    await analyzeAndStore(lead, user.id);
    recomputeLeadScore(leadId);
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true };
  } catch (err) {
    console.error("[leads] análise falhou:", err);
    return { ok: false, error: "Não conseguimos analisar esta empresa agora. Tente novamente." };
  }
}

export async function addNote(leadId: string, content: string): Promise<void> {
  if (!content.trim()) return;
  const db = getDb();
  const user = await getCurrentUser();
  db.notes.push({
    id: uid("note"),
    lead_id: leadId,
    author_id: user.id,
    content: content.trim(),
    created_at: nowIso(),
  });
  logActivity(leadId, "nota_adicionada", "Nota interna adicionada", user.id);
  saveDb();
  revalidatePath(`/leads/${leadId}`);
}

/* ---------------- Ações em lote ---------------- */

export async function bulkArchive(ids: string[]): Promise<void> {
  const db = getDb();
  const user = await getCurrentUser();
  for (const id of ids) {
    const lead = db.leads.find((l) => l.id === id);
    if (lead) {
      lead.archived = true;
      lead.updated_at = nowIso();
      db.audit_logs.push({
        id: uid("aud"),
        organization_id: db.organization.id,
        user_id: user.id,
        action: "lead.archived",
        entity: "lead",
        entity_id: id,
        detail: lead.company_name,
        created_at: nowIso(),
      });
    }
  }
  saveDb();
  revalidatePath("/leads");
}

export async function bulkAssign(ids: string[], userId: string): Promise<void> {
  const db = getDb();
  const actor = await getCurrentUser();
  const target = db.users.find((u) => u.id === userId);
  for (const id of ids) {
    const lead = db.leads.find((l) => l.id === id);
    if (lead && target) {
      lead.assigned_to = userId;
      lead.updated_at = nowIso();
      logActivity(id, "responsavel_alterado", `Responsável alterado para ${target.name}`, actor.id);
    }
  }
  saveDb();
  revalidatePath("/leads");
}

export async function bulkStatus(ids: string[], status: LeadStatus): Promise<void> {
  const user = await getCurrentUser();
  for (const id of ids) setLeadStatus(id, status, user.id);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
}

export async function bulkCampaign(ids: string[], campaignId: string): Promise<void> {
  const db = getDb();
  for (const id of ids) {
    const lead = db.leads.find((l) => l.id === id);
    if (lead) {
      lead.campaign_id = campaignId;
      lead.updated_at = nowIso();
    }
  }
  saveDb();
  revalidatePath("/leads");
  revalidatePath("/campanhas");
}

export async function bulkAnalyze(ids: string[]): Promise<{ analyzed: number }> {
  const db = getDb();
  const user = await getCurrentUser();
  let analyzed = 0;
  for (const id of ids.slice(0, 25)) {
    const lead = db.leads.find((l) => l.id === id);
    if (lead) {
      try {
        await analyzeAndStore(lead, user.id);
        recomputeLeadScore(id);
        analyzed++;
      } catch {
        // erro em um lead não interrompe o lote
      }
    }
  }
  revalidatePath("/leads");
  return { analyzed };
}

export async function bulkRescore(ids: string[]): Promise<void> {
  for (const id of ids) recomputeLeadScore(id);
  revalidatePath("/leads");
}

/* ---------------- Importação CSV ---------------- */

export interface CsvRow {
  company_name: string;
  segment?: string;
  contact_name?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  instagram?: string;
  city?: string;
  state?: string;
  country?: string;
}

export async function importCsvRows(
  rows: CsvRow[]
): Promise<{ imported: number; duplicates: number; errors: number }> {
  const db = getDb();
  const user = await getCurrentUser();
  let imported = 0;
  let duplicates = 0;
  let errors = 0;

  for (const row of rows.slice(0, 500)) {
    try {
      if (!row.company_name?.trim()) {
        errors++;
        continue;
      }
      const raw: RawLead = {
        company_name: row.company_name.trim(),
        segment: row.segment?.trim() || "Não informado",
        phone: row.phone?.trim() || undefined,
        whatsapp: row.whatsapp?.trim() || undefined,
        email: row.email?.trim() || undefined,
        website: row.website?.trim() || undefined,
        instagram: row.instagram?.trim() || undefined,
        country: row.country?.trim() || db.settings.default_country,
        state: row.state?.trim() || undefined,
        city: row.city?.trim() || "Não informada",
        source: "csv",
        website_quality: row.website ? "desconhecido" : "nenhum",
        instagram_active: Boolean(row.instagram),
        business_active: true,
      };
      if (findDuplicate(raw, db.leads)) {
        duplicates++;
        continue;
      }
      const lead = createLeadFromRaw(raw, null, user.id);
      if (row.contact_name?.trim()) lead.contact_name = row.contact_name.trim();
      imported++;
    } catch {
      errors++;
    }
  }
  saveDb();
  revalidatePath("/leads");
  return { imported, duplicates, errors };
}

/* ---------------- Exportação ---------------- */

export async function exportLeadsCsv(ids: string[]): Promise<string> {
  const db = getDb();
  const rows = db.leads.filter((l) => ids.includes(l.id));
  const header = [
    "empresa", "contato", "nicho", "telefone", "whatsapp", "email", "site",
    "instagram", "cidade", "estado", "pais", "score", "status", "origem", "criado_em",
  ];
  const esc = (v: string | number | null) =>
    v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`;
  const lines = rows.map((l) =>
    [
      l.company_name, l.contact_name, l.segment, l.phone, l.whatsapp, l.email,
      l.website, l.instagram, l.city, l.state, l.country, l.lead_score, l.status,
      l.source, l.created_at,
    ].map(esc).join(";")
  );
  return [header.join(";"), ...lines].join("\n");
}
