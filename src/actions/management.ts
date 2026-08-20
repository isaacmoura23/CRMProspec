"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { logActivity } from "@/services/lead-service";
import type { CompanyProfile, ProposalStatus, Role } from "@/types";

/* ---------------- Campanhas ---------------- */

export async function createCampaign(name: string, description?: string): Promise<{ error?: string }> {
  if (name.trim().length < 3) return { error: "Nome muito curto." };
  const db = getDb();
  db.campaigns.push({
    id: uid("cmp"),
    organization_id: db.organization.id,
    name: name.trim(),
    description: description?.trim() || null,
    created_at: nowIso(),
    archived: false,
  });
  saveDb();
  revalidatePath("/campanhas");
  return {};
}

export async function archiveCampaign(id: string): Promise<void> {
  const db = getDb();
  const c = db.campaigns.find((c) => c.id === id);
  if (c) {
    c.archived = true;
    saveDb();
    revalidatePath("/campanhas");
  }
}

/* ---------------- Propostas ---------------- */

const proposalSchema = z.object({
  lead_id: z.string().min(1),
  service: z.string().min(3).max(200),
  value: z.number().min(0),
  discount: z.number().min(0).max(100),
  valid_days: z.number().int().min(1).max(365),
  notes: z.string().max(600).optional(),
});

export type ProposalInput = z.infer<typeof proposalSchema>;

export async function createProposal(input: ProposalInput): Promise<{ error?: string }> {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return { error: "Preencha cliente, serviço e valor." };
  const d = parsed.data;
  const db = getDb();
  const user = await getCurrentUser();
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + d.valid_days);

  db.proposals.push({
    id: uid("prop"),
    organization_id: db.organization.id,
    lead_id: d.lead_id,
    service: d.service,
    value: d.value,
    discount: d.discount,
    valid_until: validUntil.toISOString(),
    notes: d.notes || null,
    status: "rascunho",
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  const lead = db.leads.find((l) => l.id === d.lead_id);
  if (lead && !lead.potential_value) {
    lead.potential_value = Math.round(d.value * (1 - d.discount / 100));
  }
  logActivity(d.lead_id, "proposta_enviada", `Proposta criada: ${d.service}`, user.id);
  saveDb();
  revalidatePath("/propostas");
  return {};
}

export async function setProposalStatus(id: string, status: ProposalStatus): Promise<void> {
  const db = getDb();
  const p = db.proposals.find((p) => p.id === id);
  if (!p) return;
  const user = await getCurrentUser();
  p.status = status;
  p.updated_at = nowIso();

  const lead = db.leads.find((l) => l.id === p.lead_id);
  if (lead) {
    if (status === "enviada") {
      lead.status = "proposta";
      const stage = db.pipeline_stages.find((s) => s.name === "Proposta");
      if (stage) lead.pipeline_stage_id = stage.id;
    }
    if (status === "aceita") {
      lead.status = "fechado";
      const stage = db.pipeline_stages.find((s) => s.is_won);
      if (stage) lead.pipeline_stage_id = stage.id;
      lead.potential_value = Math.round(p.value * (1 - p.discount / 100));
      logActivity(lead.id, "fechamento", `Proposta aceita — ${p.service}`, user.id);
    }
    lead.updated_at = nowIso();
  }
  saveDb();
  revalidatePath("/propostas");
  revalidatePath("/pipeline");
  revalidatePath("/clientes");
}

/* ---------------- Automações ---------------- */

const automationSchema = z.object({
  name: z.string().min(3).max(100),
  trigger: z.string().min(3),
  condition: z.string().min(1),
  actions: z.array(z.string().min(3)).min(1),
});

export type AutomationInput = z.infer<typeof automationSchema>;

export async function createAutomation(input: AutomationInput): Promise<{ error?: string }> {
  const parsed = automationSchema.safeParse(input);
  if (!parsed.success) return { error: "Preencha gatilho, condição e pelo menos uma ação." };
  const db = getDb();
  db.automation_rules.push({
    id: uid("auto"),
    organization_id: db.organization.id,
    ...parsed.data,
    active: true,
    runs: 0,
    created_at: nowIso(),
  });
  saveDb();
  revalidatePath("/automacoes");
  return {};
}

export async function toggleAutomation(id: string): Promise<void> {
  const db = getDb();
  const rule = db.automation_rules.find((r) => r.id === id);
  if (rule) {
    rule.active = !rule.active;
    saveDb();
    revalidatePath("/automacoes");
  }
}

export async function deleteAutomation(id: string): Promise<void> {
  const db = getDb();
  db.automation_rules = db.automation_rules.filter((r) => r.id !== id);
  saveDb();
  revalidatePath("/automacoes");
}

/* ---------------- Configurações ---------------- */

export async function updateOrganization(patch: {
  name?: string;
  currency?: string;
  timezone?: string;
  country?: string;
}): Promise<void> {
  const db = getDb();
  Object.assign(db.organization, patch);
  saveDb();
  revalidatePath("/configuracoes");
}

export async function updateSettings(patch: Partial<{
  default_niche: string;
  default_country: string;
  min_score: number;
  message_tone: string;
  message_language: string;
}>): Promise<void> {
  const db = getDb();
  Object.assign(db.settings, patch);
  saveDb();
  revalidatePath("/configuracoes");
}

export async function updateCompanyProfile(profile: Omit<CompanyProfile, "organization_id">): Promise<void> {
  const db = getDb();
  db.company_profile = { ...profile, organization_id: db.organization.id };
  saveDb();
  revalidatePath("/configuracoes");
}

export async function updateUserProfile(patch: { name?: string; email?: string }): Promise<void> {
  const db = getDb();
  const user = await getCurrentUser();
  const stored = db.users.find((u) => u.id === user.id);
  if (stored) {
    if (patch.name?.trim()) stored.name = patch.name.trim();
    if (patch.email?.trim()) stored.email = patch.email.trim();
    saveDb();
    revalidatePath("/configuracoes");
  }
}

export async function completeOnboarding(data: {
  company_name: string;
  what_we_sell: string;
  target_customers: string;
  priority_niches: string[];
  default_country: string;
  communication_style: string;
}): Promise<void> {
  const db = getDb();
  db.organization.name = data.company_name || db.organization.name;
  db.company_profile.company_name = data.company_name || db.company_profile.company_name;
  if (data.what_we_sell) db.company_profile.what_we_sell = data.what_we_sell;
  if (data.target_customers) db.company_profile.target_customers = data.target_customers;
  if (data.priority_niches.length) db.company_profile.priority_niches = data.priority_niches;
  if (data.communication_style) db.company_profile.communication_style = data.communication_style;
  if (data.default_country) db.settings.default_country = data.default_country;
  db.onboarding_completed = true;
  saveDb();
  revalidatePath("/", "layout");
}

/* ---------------- Equipe ---------------- */

export async function inviteMember(name: string, email: string, role: Role): Promise<{ error?: string }> {
  if (name.trim().length < 2 || !email.includes("@")) return { error: "Informe nome e e-mail válidos." };
  const db = getDb();
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return { error: "Já existe um membro com este e-mail." };
  }
  db.users.push({
    id: uid("usr"),
    organization_id: db.organization.id,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    avatar_url: null,
    created_at: nowIso(),
  });
  saveDb();
  revalidatePath("/equipe");
  return {};
}

export async function changeMemberRole(userId: string, role: Role): Promise<{ error?: string }> {
  const db = getDb();
  const member = db.users.find((u) => u.id === userId);
  if (!member) return {};
  if (member.role === "owner") return { error: "O papel do Owner não pode ser alterado." };
  member.role = role;
  saveDb();
  revalidatePath("/equipe");
  return {};
}

/* ---------------- Webhooks ---------------- */

export async function createWebhook(url: string, events: string[]): Promise<{ error?: string }> {
  if (!/^https?:\/\/.+/.test(url)) return { error: "URL inválida." };
  if (events.length === 0) return { error: "Selecione pelo menos um evento." };
  const db = getDb();
  db.webhooks.push({
    id: uid("wh"),
    organization_id: db.organization.id,
    url,
    events,
    active: true,
    created_at: nowIso(),
  });
  saveDb();
  revalidatePath("/integracoes");
  return {};
}

export async function deleteWebhook(id: string): Promise<void> {
  const db = getDb();
  db.webhooks = db.webhooks.filter((w) => w.id !== id);
  saveDb();
  revalidatePath("/integracoes");
}
