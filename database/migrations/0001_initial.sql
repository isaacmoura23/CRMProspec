-- ============================================================
-- ProspecAtlas — Schema PostgreSQL/Supabase
-- Migration 0001: estrutura inicial multi-tenant com RLS
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- Organizações e usuários ----------

create table organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  logo_url text,
  currency text not null default 'BRL',
  timezone text not null default 'America/Sao_Paulo',
  country text not null default 'Brasil',
  created_at timestamptz not null default now()
);

-- Perfis vinculados ao auth.users do Supabase
create table users (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create type member_role as enum ('owner', 'admin', 'sdr', 'vendedor', 'viewer');

create table organization_members (
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role member_role not null default 'sdr',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table company_profiles (
  organization_id uuid primary key references organizations (id) on delete cascade,
  company_name text not null default '',
  what_we_sell text not null default '',
  target_customers text not null default '',
  main_services text[] not null default '{}',
  average_ticket text not null default '',
  differentiators text[] not null default '{}',
  problems_we_solve text[] not null default '{}',
  priority_niches text[] not null default '{}',
  communication_style text not null default '',
  never_say text[] not null default '{}'
);

-- ---------- Pipeline ----------

create table pipelines (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null default 'Pipeline comercial',
  created_at timestamptz not null default now()
);

create table pipeline_stages (
  id uuid primary key default uuid_generate_v4(),
  pipeline_id uuid not null references pipelines (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  "order" int not null default 0,
  color text,
  is_won boolean not null default false,
  is_lost boolean not null default false
);

-- ---------- Leads ----------

create type lead_source as enum ('google_places', 'diretorio', 'csv', 'manual', 'webhook', 'demo');
create type lead_status as enum (
  'novo','analisado','qualificado','pronto_contato','contatado','respondeu',
  'interessado','demo','reuniao','proposta','negociacao','fechado','perdido'
);
create type temperature as enum ('frio','medio','bom','quente');
create type website_quality as enum ('nenhum','ruim','desatualizado','bom','desconhecido');
create type catalog_size as enum ('nenhum','pequeno','medio','grande','desconhecido');

create table leads (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,

  company_name text not null,
  contact_name text,
  legal_name text,
  segment text not null,
  description text,

  phone text,
  whatsapp text,
  email text,

  website text,
  instagram text,
  facebook text,
  linkedin text,
  google_maps_url text,

  country text not null,
  state text,
  city text not null,
  address text,

  reviews_count int,
  rating numeric(2,1),
  opening_hours text,

  source lead_source not null default 'manual',
  source_id text,
  campaign_id uuid,

  has_website boolean not null default false,
  website_quality website_quality not null default 'desconhecido',
  has_whatsapp boolean not null default false,
  instagram_active boolean not null default false,
  marketing_signals boolean not null default false,
  business_active boolean not null default true,
  catalog_size catalog_size not null default 'desconhecido',

  status lead_status not null default 'novo',
  pipeline_stage_id uuid references pipeline_stages (id) on delete set null,
  stage_entered_at timestamptz,

  lead_score int check (lead_score between 0 and 100),
  temperature temperature,
  potential_value numeric(12,2),

  assigned_to uuid references users (id) on delete set null,
  archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_contact_at timestamptz,
  next_follow_up_at timestamptz
);

create index leads_org_idx on leads (organization_id);
create index leads_org_status_idx on leads (organization_id, status);
create index leads_org_score_idx on leads (organization_id, lead_score desc);
create index leads_phone_idx on leads (organization_id, phone);
create index leads_email_idx on leads (organization_id, email);
create index leads_instagram_idx on leads (organization_id, instagram);

-- ---------- Análises e score ----------

create table lead_analysis (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  digital_presence_summary text not null,
  strengths text[] not null default '{}',
  main_problem text not null,
  problem_impact text not null,
  recommended_solution text not null,
  commercial_angle text not null,
  confidence int not null check (confidence between 0 and 100),
  model text not null,
  created_at timestamptz not null default now()
);

create table lead_score_history (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  score int not null check (score between 0 and 100),
  classification temperature not null,
  factors jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- ---------- Atividades, notas e tarefas ----------

create table activities (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  type text not null,
  description text not null,
  user_id uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index activities_lead_idx on activities (lead_id, created_at desc);

create table notes (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  author_id uuid not null references users (id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create type task_type as enum ('ligar','mensagem','proposta','follow_up','reuniao','demo','outra');
create type task_priority as enum ('baixa','media','alta');

create table tasks (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid references leads (id) on delete cascade,
  assigned_to uuid not null references users (id) on delete cascade,
  type task_type not null default 'outra',
  title text not null,
  description text,
  due_date timestamptz not null,
  priority task_priority not null default 'media',
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index tasks_org_due_idx on tasks (organization_id, completed, due_date);

-- ---------- Campanhas ----------

create table campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  description text,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

alter table leads
  add constraint leads_campaign_fk foreign key (campaign_id) references campaigns (id) on delete set null;

-- ---------- Conversas ----------

create table conversations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  channel text not null default 'whatsapp',
  last_message_at timestamptz not null default now(),
  unread boolean not null default false
);

create table messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  content text not null,
  classification text,
  created_at timestamptz not null default now()
);
create index messages_conv_idx on messages (conversation_id, created_at);

-- ---------- Cadências ----------

create table sequences (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table sequence_steps (
  id uuid primary key default uuid_generate_v4(),
  sequence_id uuid not null references sequences (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  day_offset int not null,
  label text not null,
  "order" int not null default 0
);

create table sequence_enrollments (
  id uuid primary key default uuid_generate_v4(),
  sequence_id uuid not null references sequences (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  -- pausada automaticamente quando o lead responde
  paused boolean not null default false,
  paused_reason text,
  current_step int not null default 0,
  enrolled_at timestamptz not null default now()
);

-- ---------- IA ----------

create table ai_generations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  kind text not null,
  format text,
  tone text,
  content text not null,
  model text not null,
  saved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- Propostas ----------

create type proposal_status as enum ('rascunho','enviada','visualizada','aceita','recusada','expirada');

create table proposals (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid not null references leads (id) on delete cascade,
  service text not null,
  value numeric(12,2) not null default 0,
  discount numeric(5,2) not null default 0,
  valid_until timestamptz not null,
  notes text,
  status proposal_status not null default 'rascunho',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Integrações, webhooks e automações ----------

create table integrations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  provider text not null,
  status text not null default 'desconectada',
  config jsonb not null default '{}',
  last_sync_at timestamptz
);

create table webhooks (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  url text not null,
  events text[] not null default '{}',
  secret text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table automation_rules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  trigger text not null,
  condition text not null default 'Sempre',
  actions text[] not null default '{}',
  active boolean not null default true,
  runs int not null default 0,
  created_at timestamptz not null default now()
);

create table automation_runs (
  id uuid primary key default uuid_generate_v4(),
  rule_id uuid not null references automation_rules (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  lead_id uuid references leads (id) on delete set null,
  status text not null default 'completed',
  detail text,
  created_at timestamptz not null default now()
);

-- ---------- Jobs de prospecção ----------

create table prospecting_jobs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  params jsonb not null,
  status text not null default 'queued',
  steps jsonb not null default '[]',
  found_lead_ids uuid[] not null default '{}',
  duplicates int not null default 0,
  errors text[] not null default '{}',
  campaign_id uuid references campaigns (id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------- Notificações e auditoria ----------

create table notifications (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  title text not null,
  body text,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text not null,
  detail text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security — isolamento total entre organizações
-- ============================================================

-- helper: organizações às quais o usuário autenticado pertence
create or replace function member_organizations()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select organization_id from organization_members where user_id = auth.uid();
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'organizations','organization_members','company_profiles','pipelines','pipeline_stages',
    'leads','lead_analysis','lead_score_history','activities','notes','tasks','campaigns',
    'conversations','messages','sequences','sequence_steps','sequence_enrollments',
    'ai_generations','proposals','integrations','webhooks','automation_rules',
    'automation_runs','prospecting_jobs','notifications','audit_logs'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

-- organizations: membro vê a própria organização
create policy org_select on organizations for select
  using (id in (select member_organizations()));
create policy org_update on organizations for update
  using (id in (select member_organizations()));

-- users: cada usuário vê/edita o próprio perfil
create policy users_self_select on users for select using (id = auth.uid());
create policy users_self_update on users for update using (id = auth.uid());
create policy users_self_insert on users for insert with check (id = auth.uid());

-- organization_members
create policy members_select on organization_members for select
  using (organization_id in (select member_organizations()));

-- política padrão para todas as tabelas com organization_id
do $$
declare
  t text;
begin
  foreach t in array array[
    'company_profiles','pipelines','pipeline_stages','leads','lead_analysis',
    'lead_score_history','activities','notes','tasks','campaigns','conversations',
    'messages','sequences','sequence_steps','sequence_enrollments','ai_generations',
    'proposals','integrations','webhooks','automation_rules','automation_runs',
    'prospecting_jobs','notifications','audit_logs'
  ] loop
    execute format(
      'create policy %I_tenant_all on %I for all
         using (organization_id in (select member_organizations()))
         with check (organization_id in (select member_organizations()));',
      t, t
    );
  end loop;
end $$;

-- trigger de updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();
create trigger proposals_updated_at before update on proposals
  for each row execute function set_updated_at();
