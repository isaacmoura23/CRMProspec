/* ============================================================
 * Modelo de domínio do CRM de Prospecção
 * Espelha o schema SQL em /database/migrations
 * ============================================================ */

export type Role = "owner" | "admin" | "sdr" | "vendedor" | "viewer";

export interface Organization {
  id: string;
  name: string;
  logo_url: string | null;
  currency: string;
  timezone: string;
  country: string;
  created_at: string;
}

export interface User {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  role: Role;
  avatar_url: string | null;
  created_at: string;
}

/** Perfil da empresa usado como contexto da IA (seção "Sobre minha empresa") */
export interface CompanyProfile {
  organization_id: string;
  company_name: string;
  what_we_sell: string;
  target_customers: string;
  main_services: string[];
  average_ticket: string;
  differentiators: string[];
  problems_we_solve: string[];
  priority_niches: string[];
  communication_style: string;
  never_say: string[];
}

export type LeadStatus =
  | "novo"
  | "analisado"
  | "qualificado"
  | "pronto_contato"
  | "contatado"
  | "respondeu"
  | "interessado"
  | "demo"
  | "reuniao"
  | "proposta"
  | "negociacao"
  | "fechado"
  | "perdido";

export type Temperature = "frio" | "medio" | "bom" | "quente";

export type LeadSource =
  | "google_places"
  | "diretorio"
  | "csv"
  | "manual"
  | "webhook"
  | "demo";

export interface Lead {
  id: string;
  organization_id: string;

  company_name: string;
  contact_name: string | null;
  legal_name: string | null;
  segment: string;
  description: string | null;

  phone: string | null;
  whatsapp: string | null;
  email: string | null;

  website: string | null;
  instagram: string | null;
  facebook: string | null;
  linkedin: string | null;
  google_maps_url: string | null;

  country: string;
  state: string | null;
  city: string;
  address: string | null;

  reviews_count: number | null;
  rating: number | null;
  opening_hours: string | null;

  source: LeadSource;
  source_id: string | null;
  campaign_id: string | null;

  has_website: boolean;
  website_quality: "nenhum" | "ruim" | "desatualizado" | "bom" | "desconhecido";
  has_whatsapp: boolean;
  instagram_active: boolean;
  marketing_signals: boolean;
  business_active: boolean;
  catalog_size: "nenhum" | "pequeno" | "medio" | "grande" | "desconhecido";

  status: LeadStatus;
  pipeline_stage_id: string | null;
  stage_entered_at: string | null;

  lead_score: number | null;
  temperature: Temperature | null;
  potential_value: number | null;

  assigned_to: string | null;
  archived: boolean;

  created_at: string;
  updated_at: string;
  last_contact_at: string | null;
  next_follow_up_at: string | null;
}

export interface LeadAnalysis {
  id: string;
  lead_id: string;
  digital_presence_summary: string;
  strengths: string[];
  main_problem: string;
  problem_impact: string;
  recommended_solution: string;
  commercial_angle: string;
  confidence: number; // 0–100
  model: string;
  created_at: string;
}

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface LeadScoreEntry {
  id: string;
  lead_id: string;
  score: number;
  classification: Temperature;
  factors: ScoreFactor[];
  created_at: string;
}

export type ActivityType =
  | "lead_criado"
  | "lead_analisado"
  | "score_atualizado"
  | "mensagem_gerada"
  | "primeiro_contato"
  | "mensagem_enviada"
  | "resposta_recebida"
  | "follow_up"
  | "reuniao"
  | "proposta_enviada"
  | "etapa_alterada"
  | "status_alterado"
  | "responsavel_alterado"
  | "nota_adicionada"
  | "tarefa_criada"
  | "fechamento"
  | "perda";

export interface Activity {
  id: string;
  organization_id: string;
  lead_id: string;
  type: ActivityType;
  description: string;
  user_id: string | null;
  created_at: string;
}

export interface Note {
  id: string;
  lead_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

export type TaskType =
  | "ligar"
  | "mensagem"
  | "proposta"
  | "follow_up"
  | "reuniao"
  | "demo"
  | "outra";

export type TaskPriority = "baixa" | "media" | "alta";

export interface Task {
  id: string;
  organization_id: string;
  lead_id: string | null;
  assigned_to: string;
  type: TaskType;
  title: string;
  description: string | null;
  due_date: string; // ISO
  priority: TaskPriority;
  completed: boolean;
  completed_at: string | null;
  created_at: string;
}

export interface PipelineStage {
  id: string;
  organization_id: string;
  name: string;
  order: number;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
}

export interface Campaign {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: string;
  archived: boolean;
}

export type MessageFormat =
  | "curta"
  | "consultiva"
  | "whatsapp"
  | "instagram_dm"
  | "email"
  | "audio"
  | "follow_up";

export type MessageTone = "padrao" | "mais_curto" | "mais_direto" | "mais_informal" | "mais_profissional";

export interface AIGeneration {
  id: string;
  lead_id: string;
  kind: "analise" | "abordagem" | "audio" | "follow_up" | "resposta_objecao";
  format: MessageFormat | null;
  tone: MessageTone | null;
  content: string;
  model: string;
  saved: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  lead_id: string;
  channel: "whatsapp" | "email" | "instagram";
  last_message_at: string;
  unread: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  content: string;
  classification: string | null;
  created_at: string;
}

export type ProposalStatus =
  | "rascunho"
  | "enviada"
  | "visualizada"
  | "aceita"
  | "recusada"
  | "expirada";

export interface Proposal {
  id: string;
  organization_id: string;
  lead_id: string;
  service: string;
  value: number;
  discount: number;
  valid_until: string;
  notes: string | null;
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
}

export interface AutomationRule {
  id: string;
  organization_id: string;
  name: string;
  trigger: string;
  condition: string;
  actions: string[];
  active: boolean;
  runs: number;
  created_at: string;
}

export interface AppNotification {
  id: string;
  organization_id: string;
  user_id: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string;
  detail: string | null;
  created_at: string;
}

export interface Integration {
  id: string;
  organization_id: string;
  provider: string;
  status: "conectada" | "desconectada" | "erro";
  last_sync_at: string | null;
}

export interface Webhook {
  id: string;
  organization_id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
  /** Assina o corpo em X-ProspecAtlas-Signature (HMAC SHA-256). */
  secret?: string;
  /** Resultado da última entrega — alimenta o status exibido na tela. */
  last_status?: number | null;
  last_error?: string | null;
  last_delivery_at?: string | null;
  consecutive_failures?: number;
}

/* ---------- Prospecção / Jobs ---------- */

export interface SearchParams {
  niche: string;
  country: string;
  state?: string;
  city: string;
  region?: string;
  quantity: number;
  /** IDs de origem (ex.: place_id) já retornados em buscas anteriores — nunca repetir */
  excludeSourceIds?: string[];
  /**
   * Nomes de empresas que já estão na base para esta cidade. Um provider
   * gerado (o diretório de demonstração) usa isto para não propor de novo
   * um negócio que o dedupe descartaria adiante — e, diferente do
   * source_id, funciona também para leads gravados por versões anteriores.
   */
  excludeNames?: string[];
  filters: {
    hasPhone?: boolean;
    hasWhatsapp?: boolean;
    hasInstagram?: boolean;
    hasEmail?: boolean;
    noWebsite?: boolean;
    hasWebsite?: boolean;
    badWebsite?: boolean;
    activeBusiness?: boolean;
    hasReviews?: boolean;
    strongSocial?: boolean;
  };
  campaignName?: string;
}

/** Dado bruto retornado por um provider antes de virar Lead */
export interface RawLead {
  company_name: string;
  segment: string;
  description?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  instagram?: string;
  facebook?: string;
  country: string;
  state?: string;
  city: string;
  address?: string;
  reviews_count?: number;
  rating?: number;
  opening_hours?: string;
  source: LeadSource;
  source_id?: string;
  website_quality?: Lead["website_quality"];
  instagram_active?: boolean;
  marketing_signals?: boolean;
  business_active?: boolean;
  catalog_size?: Lead["catalog_size"];
  google_maps_url?: string;
  /** Link agregador (Linktree etc.) usado no enriquecimento quando não há site próprio */
  social_link?: string;
}

export type JobStepKey = "finding" | "enriching" | "scoring" | "analyzing";

export interface JobStep {
  key: JobStepKey;
  label: string;
  done: number;
  total: number;
  status: "queued" | "processing" | "completed" | "failed";
}

export interface ProspectingJob {
  id: string;
  organization_id: string;
  params: SearchParams;
  status: "queued" | "processing" | "completed" | "failed";
  steps: JobStep[];
  found_lead_ids: string[];
  duplicates: number;
  /** Empresas descartadas por não atenderem aos filtros escolhidos */
  filtered?: number;
  errors: string[];
  campaign_id: string | null;
  created_at: string;
  finished_at: string | null;
}

/* ---------- Snapshot completo do banco (modo demo/local) ---------- */

export interface Database {
  organization: Organization;
  users: User[];
  company_profile: CompanyProfile;
  leads: Lead[];
  lead_analysis: LeadAnalysis[];
  lead_score_history: LeadScoreEntry[];
  pipeline_stages: PipelineStage[];
  activities: Activity[];
  notes: Note[];
  tasks: Task[];
  campaigns: Campaign[];
  ai_generations: AIGeneration[];
  conversations: Conversation[];
  messages: Message[];
  proposals: Proposal[];
  automation_rules: AutomationRule[];
  notifications: AppNotification[];
  audit_logs: AuditLog[];
  integrations: Integration[];
  webhooks: Webhook[];
  prospecting_jobs: ProspectingJob[];
  /** IDs de origem já entregues em prospecções — garante empresas novas a cada busca */
  seen_source_ids?: string[];
  settings: {
    default_niche: string;
    default_country: string;
    min_score: number;
    message_tone: string;
    message_language: string;
  };
  onboarding_completed: boolean;
}
