"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { getAdminUser, getCurrentUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { logActivity } from "@/services/lead-service";
import type { CompanyProfile, ProposalStatus, Role } from "@/types";

/* ---------------- Campanhas ---------------- */

export async function createCampaign(name: string, description?: string): Promise<{ error?: string }> {
  await getCurrentUser();
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
  await getCurrentUser();
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

const proposalStatusSchema = z.enum([
  "rascunho",
  "enviada",
  "visualizada",
  "aceita",
  "recusada",
  "expirada",
]) satisfies z.ZodType<ProposalStatus>;

export async function createProposal(input: ProposalInput): Promise<{ error?: string }> {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Revise os campos: cliente, serviço, valor e desconto entre 0 e 100%." };
  }
  const d = parsed.data;
  const db = getDb();
  const user = await getCurrentUser();
  // Sem esta checagem a proposta ficava órfã, apontando para um lead inexistente.
  if (!db.leads.some((l) => l.id === d.lead_id)) {
    return { error: "Selecione um lead válido para a proposta." };
  }
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
  // A proposta altera o valor potencial do lead, exibido nestas telas.
  revalidatePath(`/leads/${d.lead_id}`);
  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return {};
}

export async function setProposalStatus(id: string, status: ProposalStatus): Promise<void> {
  if (!proposalStatusSchema.safeParse(status).success) return;
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
  // O status da proposta também move o status do lead.
  revalidatePath("/leads");
  revalidatePath(`/leads/${p.lead_id}`);
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
  await getCurrentUser();
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
  await getCurrentUser();
  const db = getDb();
  const rule = db.automation_rules.find((r) => r.id === id);
  if (rule) {
    rule.active = !rule.active;
    saveDb();
    revalidatePath("/automacoes");
  }
}

export async function deleteAutomation(id: string): Promise<void> {
  await getCurrentUser();
  const db = getDb();
  db.automation_rules = db.automation_rules.filter((r) => r.id !== id);
  saveDb();
  revalidatePath("/automacoes");
}

/* ---------------- Configurações ---------------- */

/**
 * Os três schemas abaixo existem porque `Object.assign` com um patch vindo
 * do cliente é mass assignment: sem eles dá para sobrescrever campos que
 * nem aparecem no formulário e gravar tipos errados (`min_score: "abc"`).
 */
const organizationPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    currency: z.string().trim().min(1).max(10),
    timezone: z.string().trim().min(1).max(60),
    country: z.string().trim().min(1).max(60),
  })
  .partial()
  .strict();

const settingsPatchSchema = z
  .object({
    default_niche: z.string().trim().max(80),
    default_country: z.string().trim().max(60),
    min_score: z.number().int().min(0).max(100),
    message_tone: z.string().trim().max(60),
    message_language: z.string().trim().max(40),
  })
  .partial()
  .strict();

const companyProfileSchema = z.object({
  company_name: z.string().trim().min(2).max(120),
  what_we_sell: z.string().trim().max(2000).default(""),
  target_customers: z.string().trim().max(2000).default(""),
  main_services: z.array(z.string().trim()).default([]),
  average_ticket: z.string().trim().max(120).default(""),
  differentiators: z.array(z.string().trim()).default([]),
  problems_we_solve: z.array(z.string().trim()).default([]),
  priority_niches: z.array(z.string().trim()).default([]),
  communication_style: z.string().trim().max(1000).default(""),
  never_say: z.array(z.string().trim()).default([]),
});

export async function updateOrganization(patch: {
  name?: string;
  currency?: string;
  timezone?: string;
  country?: string;
}): Promise<{ error?: string }> {
  if (!(await getAdminUser())) return { error: "Apenas owner ou admin podem alterar a organização." };
  const parsed = organizationPatchSchema.safeParse(patch);
  if (!parsed.success) return { error: "Dados da organização inválidos." };
  const db = getDb();
  Object.assign(db.organization, parsed.data);
  saveDb();
  // O nome da organização aparece na sidebar de todas as páginas.
  revalidatePath("/", "layout");
  return {};
}

export async function updateSettings(patch: Partial<{
  default_niche: string;
  default_country: string;
  min_score: number;
  message_tone: string;
  message_language: string;
}>): Promise<{ error?: string }> {
  await getCurrentUser();
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) return { error: "Configurações inválidas." };
  const db = getDb();
  Object.assign(db.settings, parsed.data);
  saveDb();
  revalidatePath("/configuracoes");
  return {};
}

export async function updateCompanyProfile(
  profile: Omit<CompanyProfile, "organization_id">
): Promise<{ error?: string }> {
  await getCurrentUser();
  // Sem os defaults, um perfil salvo sem `never_say`/`main_services` fazia
  // os prompts quebrarem com "Cannot read properties of undefined (join)".
  const parsed = companyProfileSchema.safeParse(profile);
  if (!parsed.success) return { error: "Perfil da empresa inválido." };
  const db = getDb();
  db.company_profile = { ...parsed.data, organization_id: db.organization.id };
  saveDb();
  revalidatePath("/configuracoes");
  return {};
}

export async function updateUserProfile(patch: { name?: string; email?: string }): Promise<void> {
  const db = getDb();
  const user = await getCurrentUser();
  const stored = db.users.find((u) => u.id === user.id);
  if (stored) {
    if (patch.name?.trim()) stored.name = patch.name.trim().slice(0, 120);
    if (patch.email?.trim()) stored.email = patch.email.trim().toLowerCase().slice(0, 160);
    saveDb();
    // Nome e avatar do usuário aparecem na topbar de todas as páginas.
    revalidatePath("/", "layout");
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
  await getCurrentUser();
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

const roleSchema = z.enum(["owner", "admin", "sdr", "vendedor", "viewer"]);

const memberInviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  role: roleSchema,
});

export async function inviteMember(name: string, email: string, role: Role): Promise<{ error?: string }> {
  if (!(await getAdminUser())) return { error: "Apenas owner ou admin podem convidar membros." };
  const parsed = memberInviteSchema.safeParse({ name, email, role });
  if (!parsed.success) return { error: "Informe nome e e-mail válidos." };
  ({ name, email, role } = parsed.data);
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
  const admin = await getAdminUser();
  if (!admin) return { error: "Apenas owner ou admin podem alterar papéis." };
  if (!roleSchema.safeParse(role).success) return { error: "Papel inválido." };
  if (role === "owner") return { error: "Não é possível promover outro membro a Owner." };
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

/**
 * Endereços que apontam de volta para a própria infraestrutura. Um webhook
 * é uma URL que o servidor virá a chamar, então aceitar localhost, IPs de
 * rede interna ou o metadata endpoint da cloud é SSRF.
 */
function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (host === "169.254.169.254" || host === "metadata.google.internal") return false;
  if (host === "[::1]" || host === "::1") return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  return true;
}

export async function createWebhook(url: string, events: string[]): Promise<{ error?: string }> {
  if (!(await getAdminUser())) return { error: "Apenas owner ou admin podem criar webhooks." };
  if (!isPublicHttpUrl(url)) {
    return { error: "Informe uma URL pública válida (http/https, sem endereços internos)." };
  }
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
  if (!(await getAdminUser())) return;
  const db = getDb();
  db.webhooks = db.webhooks.filter((w) => w.id !== id);
  saveDb();
  revalidatePath("/integracoes");
}
