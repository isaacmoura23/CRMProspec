/* ============================================================
 * Modelo de domínio do AgentOS (agentes de IA que operam o funil).
 * Espelha database/migrations/0005_agentes.sql.
 * ============================================================ */

export const AGENT_IDS = ["niche-analyst", "prospector", "presence", "seller", "site-builder", "traffic-manager", "social-media"] as const;
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
  kind: "agent_task" | "outreach_message" | "conversation_reply" | "social_post" | "ad_campaign" | "ad_budget_change";
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

export type SpendKind = "places_requests" | "leads" | "llm_tokens" | "whatsapp_lookups" | "dossiers";

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
/** `abordagem` = toque a quem ainda não respondeu; `resposta` = resposta a algo que o lead escreveu. */
export type OutreachCycleKind = "abordagem" | "resposta";

export type OutreachCycleStatus = "agendado" | "reivindicado" | "enviado" | "pulado" | "falhou" | "incerto" | "cancelado";

export interface OutreachCycle {
  id: string;
  organization_id: string;
  lead_id: string;
  kind: OutreachCycleKind;
  /** 1 = primeira abordagem; 2 e 3 = acompanhamentos; 0 = resposta a uma mensagem do lead. */
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

/** Quem conduz a conversa com o lead: o agente ou você (assumiu pelo celular ou pelo painel). */
export type ConversationControl = "agente" | "humano";
/** O que a conversa espera agora: nada, a escolha de um horário, ou uma pessoa. */
export type ConversationAwaiting = "nada" | "horario" | "humano";

/** Estado da conversa por lead (o `id` é o do lead). Quem manda no lead, o que ele disse por último e o que falta. */
export interface ConversationState {
  id: string;
  organization_id: string;
  lead_id: string;
  control: ConversationControl;
  control_reason: string | null;
  awaiting: ConversationAwaiting;
  /** Horários propostos ao lead (ISO), enquanto `awaiting = horario`. */
  proposed_slots: string[];
  last_inbound_at: string | null;
  last_classification: string | null;
  /** Por que a conversa precisa de uma pessoa (quando `awaiting = humano`). */
  attention_reason: string | null;
  /** O que o lead escreveu que demonstra interesse: a prova que o Agente 5 exigirá. */
  interest_text: string | null;
  interest_at: string | null;
  created_at: string;
  updated_at: string;
}

export type MeetingStatus = "agendada" | "realizada" | "cancelada";

export interface Meeting {
  id: string;
  organization_id: string;
  lead_id: string;
  /** Início, em ISO. */
  at: string;
  duration_min: number;
  status: MeetingStatus;
  source: "agente" | "manual";
  /** O que o lead disse que o levou à reunião (citação). */
  interest_text: string | null;
  created_at: string;
  updated_at: string;
}

export type OwnerNoticeStatus = "pendente" | "enviado" | "falhou" | "incerto";

/* ------------------------------------------------------------------ */
/* Agente 5 — prévia do site                                           */
/* ------------------------------------------------------------------ */

export type SiteBuildStatus = "na_fila" | "construindo" | "verificando" | "pronto" | "falhou" | "cancelado";

export interface SiteCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Uma prévia de site construída a partir do dossiê (e só depois de interesse explícito + reunião). */
export interface SiteBuild {
  id: string;
  organization_id: string;
  lead_id: string;
  meeting_id: string | null;
  status: SiteBuildStatus;
  /** Quem escreveu a página: o gerador por modelos (determinístico) ou o Claude Code em modo restrito. */
  builder: "modelos" | "claude-code";
  /** Endereço não adivinhável da prévia (/previa/<token>). */
  token: string;
  content_hash: string | null;
  checks: SiteCheck[];
  screenshots: string[];
  error: string | null;
  /** A prévia precisa estar pronta até aqui (reunião − 2 h). */
  deadline_at: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  expires_at: string | null;
}

/** Aviso ao WhatsApp pessoal do dono (hoje: reunião marcada). */
export interface OwnerNotice {
  id: string;
  organization_id: string;
  kind: "reuniao" | "previa";
  lead_id: string | null;
  meeting_id: string | null;
  phone: string;
  body: string;
  status: OwnerNoticeStatus;
  attempts: number;
  not_before: string;
  provider_message_id: string | null;
  last_error: string | null;
  /** Vai ao gateway como referência: o mesmo aviso nunca sai duas vezes. */
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Agente 3 — dossiê de presença digital                               */
/* ------------------------------------------------------------------ */

export type DossierSourceKey = "site" | "google_maps" | "instagram" | "facebook" | "link_bio" | "youtube" | "mercadolivre" | "olx";
/** `bloqueada` = a fonte pediu login ou barrou o acesso: aparece como tal e baixa a confiança, nunca vira invenção. */
export type DossierSourceStatus = "concluida" | "parcial" | "bloqueada" | "pendente";

export interface DossierSource {
  key: DossierSourceKey;
  label: string;
  status: DossierSourceStatus;
  url: string | null;
  fetched_at: string | null;
  /** Por que está parcial, bloqueada ou pendente, em linguagem de interface. */
  note: string | null;
}

/** Trecho público que sustenta uma afirmação: de onde veio e o que dizia. */
export interface DossierEvidence {
  source: DossierSourceKey;
  url: string | null;
  excerpt: string;
}

export type DossierFindingKind = "oferta" | "identidade" | "contato" | "presenca" | "destaque" | "lacuna" | "problema";

export interface DossierFinding {
  id: string;
  kind: DossierFindingKind;
  claim: string;
  /** Sempre há ao menos uma: afirmação sem evidência não entra no dossiê. */
  evidence: DossierEvidence[];
}

export interface RubricItem {
  key: string;
  label: string;
  /** 0 a 5. */
  score: number;
  /** O que foi medido, com o dado concreto. */
  evidence: string;
}

export interface SiteAssessment {
  method: "regras" | "regras+visual";
  rubric: RubricItem[];
  /** 0 a 100. */
  total: number;
  label: "ruim" | "desatualizado" | "bom";
  reasons: string[];
  /** Capturas feitas (só com a avaliação visual ligada). */
  screenshots: Array<{ viewport: "desktop" | "mobile"; bytes: number }>;
}

/**
 * O que o dossiê comprova, em campos que o Agente 5 pode usar para montar o site.
 * Cada valor veio de uma fonte (`sources`): nada aqui é inventado nem estimado.
 */
export interface DossierProfile {
  name: string;
  segment: string | null;
  city: string | null;
  tagline: string | null;
  description: string | null;
  /** Seções do site atual (h2): a base da lista de serviços. */
  headings: string[];
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  hours: string | null;
  instagram: string | null;
  facebook: string | null;
  youtube: string | null;
  maps_url: string | null;
  rating: number | null;
  reviews: number | null;
  theme_color: string | null;
  /** De onde veio cada campo preenchido. */
  sources: Record<string, "site" | "google_maps" | "cadastro">;
}

export interface LeadDossier {
  /** O id é o do lead: um dossiê por lead, refeito de tempos em tempos. */
  id: string;
  organization_id: string;
  lead_id: string;
  status: "concluido" | "parcial";
  /** 0 a 100: cai a cada fonte bloqueada ou pendente. */
  confidence: number;
  sources: DossierSource[];
  findings: DossierFinding[];
  assessment: SiteAssessment | null;
  /** Primeira frase do maior problema comprovado (alimenta a abordagem). */
  headline_problem: string | null;
  /** Ausente em dossiês de demonstração e nos anteriores à fase 4: refaça o dossiê. */
  profile?: DossierProfile | null;
  summary: string;
  website_quality_before: string;
  website_quality_after: string;
  created_at: string;
  updated_at: string;
  valid_until: string;
}

/* ------------------------------------------------------------------ */
/* Agente 7 — Mídias sociais (Instagram)                               */
/* ------------------------------------------------------------------ */

/**
 * rascunho → pendente → aprovado → publicando → publicado | falhou; recusado e expirado encerram sem publicar.
 * "Aprovar e agendar" leva pendente → agendado (você aprovou, para uma data) → publicando → publicado.
 */
export type SocialPostStatus = "rascunho" | "pendente" | "aprovado" | "agendado" | "publicando" | "publicado" | "falhou" | "recusado" | "expirado";

/** Feed (imagem 4:5), Reels (vídeo 9:16) e Stories (imagem 9:16). */
export type PostFormat = "feed" | "reel" | "story";

export interface SocialPost {
  id: string;
  organization_id: string;
  platform: "instagram";
  /** A pauta do dia, em uma linha. */
  topic: string;
  caption: string;
  /** Feed, Reels ou Stories. */
  format: PostFormat;
  /** O criativo (imagem ou vídeo) gerado para este post; é a mídia publicada, salvo `image_url` informado à mão. */
  creative_id: string | null;
  /** Endereço público (https) da imagem informado à mão; vale no lugar do criativo. Sem mídia, o post não pode ser publicado. */
  image_url: string | null;
  /** Quando o agente sugere publicar (calendário editorial). */
  suggested_at: string | null;
  /** Quando você agendou a publicação ("Aprovar e agendar"). */
  scheduled_at: string | null;
  /** Resumo (SHA-256) do que você aprovou: legenda, formato, mídia e data. O publicador agendado confere antes de sair. */
  approved_digest: string | null;
  /** O que a imagem deveria mostrar (o agente sugere; quem fornece a imagem é você). */
  image_idea: string;
  status: SocialPostStatus;
  approval_id: string | null;
  /** Vai à rotina de publicação: o mesmo post nunca publica duas vezes. */
  idempotency_key: string;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  /** A publicação ficou sem confirmação (pode ter saído): exige conferência, nunca repete sozinha. */
  uncertain: boolean;
  /** Você mudou o texto sugerido. */
  edited: boolean;
  approved_by: string | null;
  approved_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/* ------------------------------------------------------------------ */
/* Agente 6 — Gestor de tráfego                                        */
/* ------------------------------------------------------------------ */

/** Toda campanha nasce rascunho; ativar e aumentar orçamento exigem clique, dentro dos tetos. */
export type AdCampaignStatus = "rascunho" | "pendente" | "aprovado" | "ativa" | "pausada" | "encerrada" | "recusada" | "expirada" | "falhou";

export interface AdCampaign {
  id: string;
  organization_id: string;
  name: string;
  objective: "mensagens" | "trafego" | "reconhecimento" | "leads";
  /** `manual`: sem plataforma ligada, você cria a campanha lá e o CRM guarda o controle. */
  platform: "manual" | "meta" | "google";
  status: AdCampaignStatus;
  /** Em centavos, para não somar ponto flutuante com dinheiro. */
  daily_budget_cents: number;
  start_date: string;
  end_date: string | null;
  audience: string;
  headline: string;
  body: string;
  cta: string;
  landing_url: string | null;
  /** O criativo (imagem) da campanha; com ele, a campanha só ativa depois de você aprovar a imagem. */
  creative_id: string | null;
  approval_id: string | null;
  external_id: string | null;
  idempotency_key: string;
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  activated_by: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** Desempenho de uma campanha em um dia (lido do provedor ou lançado à mão). */
export interface AdReport {
  /** `<campanha>:<dia>`: um registro por campanha por dia. */
  id: string;
  organization_id: string;
  campaign_id: string;
  day: string;
  impressions: number;
  clicks: number;
  spend_cents: number;
  conversions: number;
  source: "manual" | "provider";
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Criativos (imagens e vídeos da própria empresa, feitos em código)   */
/* ------------------------------------------------------------------ */

export type CreativeFormat = "feed" | "story" | "reel" | "anuncio";
export type CreativeStatus = "pendente" | "aprovado" | "recusado" | "expirado" | "falhou";

/**
 * Um criativo é HTML/SVG renderizado localmente (Chrome headless) e, no vídeo, cenas em PNG
 * costuradas pelo ffmpeg. Nenhuma API paga, nenhuma pessoa, foto ou marca de terceiros.
 * Só serve de fora (`/midia/<token>/…`) depois de aprovado.
 */
export interface Creative {
  id: string;
  organization_id: string;
  format: CreativeFormat;
  kind: "imagem" | "video";
  /** A que pertence: um post (calendário) ou uma campanha. */
  owner_kind: "post" | "campaign";
  owner_id: string;
  status: CreativeStatus;
  width: number;
  height: number;
  duration_s: number | null;
  /** O texto que aparece na arte (vem do post ou da campanha, nunca inventado). */
  headline: string;
  body: string;
  cta: string;
  /** Quem escreveu o HTML: os modelos de arte (determinístico) ou o Claude Code em modo restrito. */
  builder: "modelos" | "claude-code";
  /** Variação visual (muda a composição ao pedir "outro visual"). */
  variant: number;
  /** Endereço não adivinhável da mídia (/midia/<token>/<arquivo>). */
  token: string;
  /** Arquivos gravados (nomes relativos à pasta do token). */
  files: string[];
  /** SHA-256 da mídia principal: o publicador confere que nada mudou depois da aprovação. */
  content_hash: string | null;
  checks: SiteCheck[];
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/* ------------------------------------------------------------------ */
/* Agente 2 — cobertura da varredura                                   */
/* ------------------------------------------------------------------ */

/** O que já foi varrido de um nicho em uma cidade (id = `<nicho>|<cidade sem acento>`). */
export interface ProspectCoverage {
  id: string;
  organization_id: string;
  niche: string;
  niche_label: string;
  city: string;
  state: string | null;
  country: string;
  runs: number;
  /** Empresas que a fonte devolveu e o agente examinou. */
  scanned: number;
  /** Leads novos criados. */
  found: number;
  filtered: number;
  duplicates: number;
  places_requests: number;
  last_run_at: string;
  created_at: string;
  updated_at: string;
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
  conversation_state: ConversationState[];
  meetings: Meeting[];
  owner_notices: OwnerNotice[];
  lead_dossiers: LeadDossier[];
  site_builds: SiteBuild[];
  social_posts: SocialPost[];
  ad_campaigns: AdCampaign[];
  ad_reports: AdReport[];
  prospect_coverage: ProspectCoverage[];
  creatives: Creative[];
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
    conversation_state: [],
    meetings: [],
    owner_notices: [],
    lead_dossiers: [],
    site_builds: [],
    social_posts: [],
    ad_campaigns: [],
    ad_reports: [],
    prospect_coverage: [],
    creatives: [],
  };
}
