/* ============================================================
 * Modelo de domínio do módulo Carreira
 *
 * Espelha as tabelas `career_*` de database/migrations/0003_carreira.sql.
 * Todas as entidades carregam `owner_id` + `organization_id`: o titular do
 * currículo é quem manda, e nada aqui é tratado como lead comercial.
 * ============================================================ */

export interface CareerOwned {
  id: string;
  owner_id: string;
  organization_id: string;
}

/* ---------- Perfil profissional ---------- */

export interface CareerExperience {
  company: string;
  role: string;
  start: string | null; // "2021-03" / "2021" / null quando não identificado
  end: string | null; // null = atual
  description: string;
  page: number | null;
}

export interface CareerEducation {
  institution: string;
  degree: string;
  start: string | null;
  end: string | null;
  page: number | null;
}

export interface CareerProject {
  name: string;
  description: string;
  url: string | null;
  page: number | null;
}

export interface CareerProfile extends CareerOwned {
  resume_version_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  experiences: CareerExperience[];
  education: CareerEducation[];
  skills: string[];
  languages: string[];
  certifications: string[];
  projects: CareerProject[];
  links: string[];
  /** O titular revisou a extração. Só perfis confirmados alimentam candidaturas. */
  confirmed: boolean;
  extraction_model: string;
  created_at: string;
  updated_at: string;
}

/* ---------- Versões do currículo ---------- */

export type ResumeTextStatus =
  | "pendente"
  | "ok"
  | "parcial"
  | "sem_texto"
  | "ocr_pendente"
  | "ocr_indisponivel"
  | "protegido"
  | "corrompido"
  | "paginas_excedidas";

export interface ResumePage {
  page: number;
  text: string;
}

export interface ResumeLink {
  url: string;
  page: number;
  origin: "texto" | "anotacao";
}

export interface ResumeVersion extends CareerOwned {
  kind: "original" | "revisada";
  label: string;
  /** Versão de origem quando `kind === "revisada"`. */
  source_version_id: string | null;
  file_name: string;
  storage_key: string;
  size_bytes: number;
  sha256: string;
  page_count: number | null;
  text_status: ResumeTextStatus;
  text_note: string | null;
  pages: ResumePage[];
  links: ResumeLink[];
  created_at: string;
}

/* ---------- Análise ---------- */

export type CareerJobStatus = "pendente" | "processando" | "concluido" | "falhou" | "cancelado";

export type SuggestionPriority = "alta" | "media" | "baixa";

export interface ResumeCriterion {
  key: string;
  label: string;
  weight: number;
  /** null = não avaliado (o motivo vai em `note`). */
  score: number | null;
  evidence: string[];
  note: string | null;
}

export interface ResumeIssue {
  id: string;
  criterion: string;
  priority: SuggestionPriority;
  title: string;
  detail: string;
  page: number | null;
}

export interface ResumeSuggestion {
  id: string;
  priority: SuggestionPriority;
  original: string;
  problem: string;
  rationale: string;
  suggested: string;
  page: number | null;
  /** A sugestão depende de um dado que só o titular pode fornecer. */
  needs_user_input: boolean;
  status: "pendente" | "aceita" | "rejeitada";
  /** Texto final editado pelo titular (prevalece sobre `suggested`). */
  edited: string | null;
}

export interface ResumeAnalysis extends CareerOwned {
  resume_version_id: string;
  status: CareerJobStatus;
  /** Qualidade geral do currículo, 0–100 — independe de vaga. */
  score: number | null;
  criteria: ResumeCriterion[];
  issues: ResumeIssue[];
  suggestions: ResumeSuggestion[];
  not_evaluated: string[];
  context: { profession: string | null; seniority: string | null; country: string | null };
  model: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/* ---------- Links inspecionados ---------- */

export type LinkCheckStatus = "pendente" | "concluido" | "parcial" | "bloqueado" | "quebrado";

export type LinkKind =
  | "linkedin"
  | "github"
  | "gitlab"
  | "portfolio"
  | "certificado"
  | "projeto"
  | "outro";

export interface LinkCheck extends CareerOwned {
  resume_version_id: string;
  url: string;
  final_url: string | null;
  kind: LinkKind;
  status: LinkCheckStatus;
  http_status: number | null;
  checked_at: string | null;
  /** O que foi efetivamente lido (título, README, metadados…). */
  content_summary: string | null;
  evidence: string[];
  limitations: string[];
  suggestions: string[];
  /** null = não foi possível comparar com o currículo. */
  consistent_with_resume: boolean | null;
  page: number | null;
}

/* ---------- Preferências ---------- */

export type WorkMode = "remoto" | "hibrido" | "presencial";

export interface CareerPreferences {
  owner_id: string;
  organization_id: string;
  desired_roles: string[];
  locations: string[];
  work_modes: WorkMode[];
  languages: string[];
  contract_types: string[];
  min_salary: number | null;
  currency: string;
  excluded_companies: string[];
  min_match_score: number;
  /** E-mail confirmado do candidato — vira `reply_to` no Resend. */
  candidate_email: string | null;
  updated_at: string;
}

/* ---------- Vagas ---------- */

export type JobPostingStatus = "aberta" | "encerrada" | "desconhecida";

export interface JobPosting extends CareerOwned {
  source: string;
  external_id: string;
  /** Chave de deduplicação entre fontes (empresa + título + local normalizados, ou URL canônica). */
  canonical_key: string;
  title: string;
  company: string;
  description: string;
  requirements: string[];
  location: string | null;
  work_mode: WorkMode | null;
  url: string;
  apply_url: string | null;
  /** Só endereços publicados no próprio anúncio para candidatura; nunca inferidos. */
  application_email: string | null;
  application_email_evidence: string | null;
  salary: string | null;
  contract_type: string | null;
  language: string | null;
  posted_at: string | null;
  collected_at: string;
  expires_at: string | null;
  status: JobPostingStatus;
  status_checked_at: string | null;
  origin_evidence: string;
}

export interface JobMatch extends CareerOwned {
  job_id: string;
  profile_id: string;
  score: number;
  met: string[];
  gaps: string[];
  unknown: string[];
  blocked_by: string[];
  explanation: string;
  saved: boolean;
  dismissed: boolean;
  computed_at: string;
}

/* ---------- Campanhas e candidaturas ---------- */

export type ApplicationChannel = "resend" | "gmail" | "manual";

export type CampaignStatus = "rascunho" | "ativa" | "pausada" | "cancelada" | "concluida";

export interface ApplicationCampaign extends CareerOwned {
  name: string;
  status: CampaignStatus;
  /** Vagas escolhidas manualmente; vazio numa campanha recorrente pura. */
  job_ids: string[];
  recurring: boolean;
  roles: string[];
  min_score: number;
  resume_version_id: string;
  profile_id: string;
  channel: ApplicationChannel;
  daily_limit: number;
  ends_at: string | null;
  template_subject: string;
  template_body: string;
  sent_today: number;
  sent_day: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ProcessingStatus =
  | "rascunho"
  | "pendente"
  | "enfileirada"
  | "processando"
  | "acao_manual"
  | "resultado_incerto"
  | "falhou"
  | "cancelada"
  | "concluida";

export type EmailStatus =
  | "aceito"
  | "enviado"
  | "entregue"
  | "atrasado"
  | "devolvido"
  | "reclamacao";

export type SelectionStatus =
  | "registrada"
  | "resposta_recebida"
  | "entrevista"
  | "proposta"
  | "contratado"
  | "rejeitado"
  | "retirada";

export interface JobApplication extends CareerOwned {
  campaign_id: string | null;
  job_id: string;
  canonical_key: string;
  profile_id: string;
  resume_version_id: string;
  match_score: number | null;
  channel: ApplicationChannel;
  recipient: string | null;
  subject: string;
  body_text: string;
  body_html: string;
  /** Snapshot do anúncio no momento do envio. */
  job_snapshot: { title: string; company: string; url: string; description_excerpt: string };
  processing_status: ProcessingStatus;
  email_status: EmailStatus | null;
  selection_status: SelectionStatus;
  provider_message_id: string | null;
  /** Fixa por candidatura: os retries reutilizam a mesma chave. */
  idempotency_key: string;
  attempts_count: number;
  last_error: string | null;
  manual_apply_url: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationAttempt extends CareerOwned {
  application_id: string;
  number: number;
  idempotency_key: string;
  channel: ApplicationChannel;
  outcome: "sucesso" | "falha" | "incerto" | "cancelada" | "acao_manual";
  provider_message_id: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export type ApplicationEventSource = "sistema" | "provedor" | "webhook" | "manual";

export interface ApplicationEvent extends CareerOwned {
  application_id: string;
  type: string;
  source: ApplicationEventSource;
  detail: string | null;
  provider_event_id: string | null;
  /** Horário em que o evento ocorreu no provedor (pode chegar fora de ordem). */
  occurred_at: string;
  created_at: string;
}

/* ---------- Fila durável ---------- */

export type CareerJobKind =
  | "analyze_resume"
  | "check_links"
  | "search_jobs"
  | "campaign_tick"
  | "send_application"
  | "recheck_job";

export interface CareerJob extends CareerOwned {
  kind: CareerJobKind;
  payload: Record<string, unknown>;
  status: CareerJobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_until: string | null;
  lock_owner: string | null;
  last_error: string | null;
  progress: { done: number; total: number; label: string } | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/* ---------- Conexões com provedores ---------- */

export interface ProviderConnection extends CareerOwned {
  provider: "gmail";
  account_email: string;
  /** Tokens cifrados com AES-256-GCM (CAREER_TOKEN_SECRET). */
  encrypted_tokens: string;
  scopes: string[];
  expires_at: string | null;
  status: "ativa" | "expirada" | "revogada";
  created_at: string;
  updated_at: string;
}

/** Recibos de webhook: evita reprocessar o mesmo evento. */
export interface WebhookReceipt {
  id: string;
  provider: "resend";
  received_at: string;
}

/* ---------- Snapshot local (modo demo) ---------- */

export interface CareerData {
  profiles: CareerProfile[];
  resumes: ResumeVersion[];
  analyses: ResumeAnalysis[];
  link_checks: LinkCheck[];
  preferences: CareerPreferences[];
  jobs: JobPosting[];
  matches: JobMatch[];
  campaigns: ApplicationCampaign[];
  applications: JobApplication[];
  attempts: ApplicationAttempt[];
  events: ApplicationEvent[];
  queue: CareerJob[];
  connections: ProviderConnection[];
  webhook_receipts: WebhookReceipt[];
}

export function emptyCareerData(): CareerData {
  return {
    profiles: [],
    resumes: [],
    analyses: [],
    link_checks: [],
    preferences: [],
    jobs: [],
    matches: [],
    campaigns: [],
    applications: [],
    attempts: [],
    events: [],
    queue: [],
    connections: [],
    webhook_receipts: [],
  };
}
