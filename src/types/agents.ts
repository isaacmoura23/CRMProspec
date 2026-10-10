/* ============================================================
 * Modelo de domínio do AgentOS (agentes de IA que operam o funil).
 * Espelha database/migrations/0005_agentes.sql.
 * ============================================================ */

export const AGENT_IDS = ["niche-analyst", "prospector", "seller"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * - `pausado`: nada roda para este agente (tarefas ficam na fila, intactas).
 * - `aprovacao`: o que o agente decide iniciar sozinho vira um pedido em
 *   /agentes/aprovacao e só executa depois do clique. Uma execução pedida
 *   por uma pessoa ("executar agora") já é a aprovação.
 * - `automatico`: o agente inicia e executa sozinho, dentro dos tetos.
 */
export type AgentMode = "pausado" | "aprovacao" | "automatico";

export const AGENT_MODES: readonly AgentMode[] = ["pausado", "aprovacao", "automatico"];

/** Linha especial de `agent_settings`: o interruptor geral. `pausado` para tudo. */
export const GLOBAL_SETTINGS_ID = "global";

export interface AgentSettingsRow {
  id: string; // AgentId ou GLOBAL_SETTINGS_ID
  organization_id: string;
  mode: AgentMode;
  config: Record<string, unknown>;
  updated_at: string;
}

export type AgentTaskStatus = "pendente" | "processando" | "concluido" | "falhou" | "cancelado";

export interface AgentTask {
  id: string;
  organization_id: string;
  agent: AgentId;
  kind: string;
  payload: Record<string, unknown>;
  /** Impede a mesma tarefa de ser enfileirada duas vezes enquanto estiver viva. */
  dedupe_key: string | null;
  status: AgentTaskStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_until: string | null;
  lock_owner: string | null;
  last_error: string | null;
  progress: { done: number; total: number; label: string } | null;
  result: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type AgentEventLevel = "info" | "warn" | "error";

export interface AgentEvent {
  id: string;
  organization_id: string;
  agent: AgentId | "sistema";
  level: AgentEventLevel;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  task_id: string | null;
  created_at: string;
}

/** Batimento do runner. Um registro por instância; o mais recente vale. */
export interface AgentHeartbeat {
  id: string;
  organization_id: string;
  instance: string;
  started_at: string;
  beat_at: string;
  info: Record<string, unknown> | null;
}

export interface NicheFactor {
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface NicheEvidence {
  label: string;
  value: string;
}

export interface NicheMetrics {
  /** Quantas empresas a fonte devolveu na amostra. */
  total: number;
  no_site: number;
  with_site: number;
  /** Sites visitados para medir qualidade, e quantos saíram fracos. */
  sites_sampled: number;
  weak_sites: number;
  with_phone: number;
  with_reviews: number;
}

export type NicheTargetStatus = "auto" | "fixado" | "banido";

export interface NicheTarget {
  id: string;
  organization_id: string;
  niche: string; // chave do provedor (imobiliaria, clinica…)
  niche_label: string;
  city: string;
  state: string | null;
  country: string;
  metrics: NicheMetrics;
  score: number;
  factors: NicheFactor[];
  evidence: NicheEvidence[];
  /** Fonte da amostra: só `google_places` representa o mercado real. */
  source: string;
  status: NicheTargetStatus;
  analyzed_at: string;
  valid_until: string;
  task_id: string | null;
}

export type ApprovalStatus = "pendente" | "aprovado" | "recusado" | "expirado";

export interface Approval {
  id: string;
  organization_id: string;
  agent: AgentId;
  /**
   * O que se aprova: uma tarefa de agente, ou uma mensagem de WhatsApp antes de
   * sair (aqui o pedido carrega o texto exato que será enviado).
   */
  kind: "agent_task" | "outreach_message";
  title: string;
  detail: string | null;
  /**
   * Para `agent_task`: { agent, kind, payload, dedupeKey }.
   * Para `outreach_message`: { lead_id, touch, phone, body }.
   */
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  task_id: string | null;
  created_at: string;
  expires_at: string;
}

export type SpendKind = "places_requests" | "leads" | "llm_tokens" | "whatsapp_lookups";

export interface SpendEntry {
  id: string;
  organization_id: string;
  agent: AgentId;
  kind: SpendKind;
  amount: number;
  note: string | null;
  /** Dia civil (America/Sao_Paulo), YYYY-MM-DD — base dos tetos diários. */
  day: string;
  created_at: string;
}

/**
 * Estado da conexão do WhatsApp como o CRM o conhece: espelho do que o gateway
 * reportou por webhook. A tela de conexão consulta o gateway ao vivo; este
 * registro é o que sobra quando o gateway está fora do ar e alimenta o aviso
 * global de "WhatsApp desconectado".
 */
export interface WhatsappLink {
  id: string; // id da sessão no gateway
  organization_id: string;
  status: "DISCONNECTED" | "QR" | "CONNECTING" | "CONNECTED" | "NEEDS_RECONNECT";
  phone: string | null;
  push_name: string | null;
  last_error: string | null;
  dry_run: boolean;
  /** Quando aconteceu a mudança (relógio do gateway) — protege contra evento fora de ordem. */
  last_event_at: string;
  updated_at: string;
}

/** Eventos do gateway já recebidos: a chave de deduplicação dos webhooks. */
export interface WhatsappReceipt {
  id: string; // id do evento
  organization_id: string;
  type: string;
  received_at: string;
}

/* ---------- Vendedor: envio por WhatsApp ---------- */

/**
 * Ciclo de envio: uma mensagem que deve sair, com tudo que decide se sai.
 *
 *   agendado → reivindicado → enviado | pulado | falhou | incerto | cancelado
 *
 * `incerto` é o envio sem confirmação (timeout): NUNCA é reenviado sozinho —
 * reenviar pode duplicar a mensagem para o lead.
 */
export type OutreachCycleStatus = "agendado" | "reivindicado" | "enviado" | "pulado" | "falhou" | "incerto" | "cancelado";

export interface OutreachCycle {
  id: string;
  organization_id: string;
  lead_id: string;
  /** 1 = primeira abordagem; 2 e 3 = acompanhamentos. */
  touch: number;
  /** Telefone em E.164, já confirmado como WhatsApp. */
  phone: string;
  /** Texto exato que sai (aprovado, se o modo exige aprovação). */
  body: string;
  status: OutreachCycleStatus;
  /** Quando a mensagem deveria sair (base da detecção de etapa obsoleta). */
  scheduled_for: string;
  /** Próxima avaliação: adiar por janela, teto ou desconexão não mexe em `scheduled_for`. */
  not_before: string;
  claimed_at: string | null;
  /** Só falhas técnicas contam; esperar desconexão, janela ou teto não conta. */
  attempts: number;
  /** Chave única do ciclo: vai ao gateway como referência e impede envio em dobro. */
  idempotency_key: string;
  approval_id: string | null;
  skip_reason: string | null;
  last_error: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export type OutreachMessageStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "UNCERTAIN";

/** Mensagem enviada ao lead, com o estado que o WhatsApp confirmou (só avança, nunca regride). */
export interface OutreachMessage {
  id: string;
  organization_id: string;
  lead_id: string;
  cycle_id: string;
  phone: string;
  body: string;
  status: OutreachMessageStatus;
  provider_message_id: string | null;
  error_detail: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

/** Quem não pode receber mensagem: pedido de parada, número sem WhatsApp, bloqueio manual. */
export interface ChannelBlock {
  /** Só os dígitos do telefone: a mesma pessoa em formatos diferentes é uma linha só. */
  id: string;
  organization_id: string;
  phone: string;
  reason: string;
  source: "manual" | "opt_out" | "invalid";
  created_at: string;
}

export interface AgentData {
  settings: AgentSettingsRow[];
  tasks: AgentTask[];
  events: AgentEvent[];
  heartbeats: AgentHeartbeat[];
  niche_targets: NicheTarget[];
  approvals: Approval[];
  spend: SpendEntry[];
  whatsapp_link: WhatsappLink[];
  whatsapp_receipts: WhatsappReceipt[];
  outreach_cycles: OutreachCycle[];
  outreach_messages: OutreachMessage[];
  channel_blocklist: ChannelBlock[];
}

export function emptyAgentData(): AgentData {
  return {
    settings: [],
    tasks: [],
    events: [],
    heartbeats: [],
    niche_targets: [],
    approvals: [],
    spend: [],
    whatsapp_link: [],
    whatsapp_receipts: [],
    outreach_cycles: [],
    outreach_messages: [],
    channel_blocklist: [],
  };
}
