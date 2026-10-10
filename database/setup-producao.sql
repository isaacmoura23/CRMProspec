-- Setup de produção — ProspecAtlas
--
-- Concatenação das migrações que rodam hoje, na ordem correta. Cole tudo no
-- SQL Editor do Supabase e execute uma vez. É idempotente: todas usam
-- "create table if not exists" / "drop policy if exists", então rodar de
-- novo não quebra nada.
--
-- A 0001_initial.sql NÃO entra aqui: é o schema completo de referência, para
-- quando todo o domínio migrar. As cinco abaixo não dependem dela.


-- ============================================================
-- 0002_leads_hibrido.sql — Leads, análises e histórico de score
-- ============================================================

-- Migração 0002 — leads, análises e histórico de score no Supabase.
--
-- Difere da 0001 (schema completo, pensado para quando TUDO estiver no
-- Postgres) por ser a fatia que roda AGORA, com o restante do sistema ainda
-- no snapshot local. As diferenças são deliberadas:
--
--   * `id` é text, não uuid. O app gera identificadores no formato
--     `lead_<hex>` e eles já circulam em tarefas, propostas, conversas e
--     atividades que continuam fora do banco; trocar para uuid quebraria
--     essas referências.
--   * `assigned_to`, `campaign_id` e `pipeline_stage_id` são text sem chave
--     estrangeira, porque usuários, campanhas e etapas ainda vivem no
--     snapshot. Viram FK quando essas tabelas migrarem.
--   * `organization_id` é text e sem FK, pela mesma razão.
--
-- Rode no SQL Editor do Supabase.

-- Enums (ignora se a 0001 já tiver criado)
do $$ begin
  create type lead_source as enum ('google_places','diretorio','csv','manual','webhook','demo');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lead_status as enum (
    'novo','analisado','qualificado','pronto_contato','contatado','respondeu',
    'interessado','demo','reuniao','proposta','negociacao','fechado','perdido'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type temperature as enum ('frio','medio','bom','quente');
exception when duplicate_object then null; end $$;

do $$ begin
  create type website_quality as enum ('nenhum','ruim','desatualizado','bom','desconhecido');
exception when duplicate_object then null; end $$;

do $$ begin
  create type catalog_size as enum ('nenhum','pequeno','medio','grande','desconhecido');
exception when duplicate_object then null; end $$;

create table if not exists app_leads (
  id text primary key,
  organization_id text not null,

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
  campaign_id text,

  has_website boolean not null default false,
  website_quality website_quality not null default 'desconhecido',
  has_whatsapp boolean not null default false,
  instagram_active boolean not null default false,
  marketing_signals boolean not null default false,
  business_active boolean not null default true,
  catalog_size catalog_size not null default 'desconhecido',

  status lead_status not null default 'novo',
  pipeline_stage_id text,
  stage_entered_at timestamptz,

  lead_score int check (lead_score between 0 and 100),
  temperature temperature,
  potential_value numeric(12,2),

  assigned_to text,
  archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_contact_at timestamptz,
  next_follow_up_at timestamptz
);

create table if not exists app_lead_analysis (
  id text primary key,
  lead_id text not null references app_leads (id) on delete cascade,
  organization_id text not null,
  digital_presence_summary text not null,
  strengths jsonb not null default '[]'::jsonb,
  main_problem text not null,
  problem_impact text not null,
  recommended_solution text not null,
  commercial_angle text not null,
  confidence int not null,
  model text,
  created_at timestamptz not null default now()
);

create table if not exists app_lead_score_history (
  id text primary key,
  lead_id text not null references app_leads (id) on delete cascade,
  organization_id text not null,
  score int not null,
  classification temperature not null,
  factors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Índices para os acessos que o app faz de fato
create index if not exists app_leads_org_idx on app_leads (organization_id) where archived = false;
create index if not exists app_leads_city_idx on app_leads (organization_id, lower(city));
create index if not exists app_leads_status_idx on app_leads (organization_id, status);

-- Unicidade contra lead repetido, garantida pelo banco.
--
-- A checagem da aplicação (services/dedupe) continua valendo e dá a mensagem
-- amigável, mas ela compara contra o que está carregado em memória: duas
-- prospecções simultâneas passariam as duas. Aqui a segunda falha no insert.
create unique index if not exists app_leads_source_unique
  on app_leads (organization_id, source_id)
  where source_id is not null;

create unique index if not exists app_leads_name_city_unique
  on app_leads (organization_id, lower(btrim(company_name)), lower(btrim(city)));

-- Telefone e Instagram identificam o mesmo negócio mesmo quando o nome muda.
create unique index if not exists app_leads_phone_unique
  on app_leads (organization_id, regexp_replace(coalesce(phone, ''), '\D', '', 'g'))
  where phone is not null and length(regexp_replace(phone, '\D', '', 'g')) >= 8;

create unique index if not exists app_leads_instagram_unique
  on app_leads (organization_id, lower(btrim(instagram, '@ ')))
  where instagram is not null and btrim(instagram, '@ ') <> '';
create unique index if not exists app_lead_analysis_lead_idx on app_lead_analysis (lead_id);
create index if not exists app_lead_score_lead_idx on app_lead_score_history (lead_id, created_at desc);

-- RLS ligado desde já. O acesso do servidor usa a service role key, que
-- ignora as políticas; deixar habilitado impede que a anon key exposta no
-- navegador leia a base caso alguém aponte o cliente para estas tabelas.
alter table app_leads enable row level security;
alter table app_lead_analysis enable row level security;
alter table app_lead_score_history enable row level security;


-- ============================================================
-- 0003_carreira.sql — Módulo Carreira: tabelas, RLS e bucket privado
-- ============================================================

-- Migração 0003 — módulo Carreira (currículos, análises, vagas, campanhas,
-- candidaturas, fila e conexões de provedores).
--
-- Compatível com o estado real do banco hoje: como na 0002, os ids são
-- `text` (o app gera `cv_<hex>`, `app_<hex>` …) e `owner_id` /
-- `organization_id` são text sem FK, porque usuários e organizações ainda
-- vivem no snapshot. Esta migração NÃO depende da 0001 nem da 0002 — pode
-- rodar sozinha no SQL Editor do Supabase.
--
-- Segurança:
--   * RLS ativado em todas as tabelas com política "só o titular"
--     (auth.uid()::text = owner_id). A service role, usada pelo backend,
--     ignora RLS por definição — por isso o código restringe todo acesso
--     pelo owner_id da sessão, nunca pelo que o cliente envia.
--   * Bucket privado `career-resumes`, com política por prefixo
--     (<owner_id>/…) para quando a autenticação real estiver ativa.
--
-- Unicidade que o app espera do banco:
--   * uma candidatura por (profile_id, canonical_key) — entre campanhas e canais;
--   * uma vaga por (owner_id, canonical_key) — dedupe entre fontes;
--   * uma preferência por owner_id;
--   * um recibo por evento de webhook (id do Svix).

create table if not exists career_profiles (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  resume_version_id text,
  full_name text not null default '',
  email text,
  phone text,
  location text,
  headline text,
  summary text,
  experiences jsonb not null default '[]'::jsonb,
  education jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  languages jsonb not null default '[]'::jsonb,
  certifications jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  links jsonb not null default '[]'::jsonb,
  confirmed boolean not null default false,
  extraction_model text not null default 'engine/heuristic-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_profiles_owner_idx on career_profiles (owner_id);

create table if not exists career_resumes (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  kind text not null check (kind in ('original','revisada')),
  label text not null,
  source_version_id text,
  file_name text not null,
  storage_key text not null,
  size_bytes bigint not null default 0,
  sha256 text not null default '',
  page_count int,
  text_status text not null default 'pendente',
  text_note text,
  pages jsonb not null default '[]'::jsonb,
  links jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists career_resumes_owner_idx on career_resumes (owner_id);
create index if not exists career_resumes_sha_idx on career_resumes (owner_id, sha256);

create table if not exists career_analyses (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  resume_version_id text not null,
  status text not null default 'pendente',
  score int,
  criteria jsonb not null default '[]'::jsonb,
  issues jsonb not null default '[]'::jsonb,
  suggestions jsonb not null default '[]'::jsonb,
  not_evaluated jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  model text not null default 'engine/heuristic-v1',
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists career_analyses_owner_idx on career_analyses (owner_id, resume_version_id);

create table if not exists career_link_checks (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  resume_version_id text not null,
  url text not null,
  final_url text,
  kind text not null default 'outro',
  status text not null default 'pendente',
  http_status int,
  checked_at timestamptz,
  content_summary text,
  evidence jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  suggestions jsonb not null default '[]'::jsonb,
  consistent_with_resume boolean,
  page int
);
create index if not exists career_link_checks_owner_idx on career_link_checks (owner_id, resume_version_id);

create table if not exists career_preferences (
  owner_id text primary key,
  organization_id text not null,
  desired_roles jsonb not null default '[]'::jsonb,
  locations jsonb not null default '[]'::jsonb,
  work_modes jsonb not null default '[]'::jsonb,
  languages jsonb not null default '[]'::jsonb,
  contract_types jsonb not null default '[]'::jsonb,
  min_salary numeric,
  currency text not null default 'BRL',
  excluded_companies jsonb not null default '[]'::jsonb,
  min_match_score int not null default 60,
  candidate_email text,
  updated_at timestamptz not null default now()
);

create table if not exists career_jobs (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  source text not null,
  external_id text not null,
  canonical_key text not null,
  title text not null,
  company text not null,
  description text not null default '',
  requirements jsonb not null default '[]'::jsonb,
  location text,
  work_mode text,
  url text not null,
  apply_url text,
  application_email text,
  application_email_evidence text,
  salary text,
  contract_type text,
  language text,
  posted_at timestamptz,
  collected_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'aberta',
  status_checked_at timestamptz,
  origin_evidence text not null default '',
  constraint career_jobs_owner_canonical_uq unique (owner_id, canonical_key)
);
create index if not exists career_jobs_owner_idx on career_jobs (owner_id);

create table if not exists career_matches (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  job_id text not null,
  profile_id text not null,
  score int not null default 0,
  met jsonb not null default '[]'::jsonb,
  gaps jsonb not null default '[]'::jsonb,
  unknown jsonb not null default '[]'::jsonb,
  blocked_by jsonb not null default '[]'::jsonb,
  explanation text not null default '',
  saved boolean not null default false,
  dismissed boolean not null default false,
  computed_at timestamptz not null default now(),
  constraint career_matches_owner_job_uq unique (owner_id, job_id)
);

create table if not exists career_campaigns (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  name text not null,
  status text not null default 'rascunho',
  job_ids jsonb not null default '[]'::jsonb,
  recurring boolean not null default false,
  roles jsonb not null default '[]'::jsonb,
  min_score int not null default 60,
  resume_version_id text not null,
  profile_id text not null,
  channel text not null check (channel in ('resend','gmail','manual')),
  daily_limit int not null default 10,
  ends_at timestamptz,
  template_subject text not null default '',
  template_body text not null default '',
  sent_today int not null default 0,
  sent_day text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_campaigns_owner_idx on career_campaigns (owner_id, status);

create table if not exists career_applications (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  campaign_id text,
  job_id text not null,
  canonical_key text not null,
  profile_id text not null,
  resume_version_id text not null,
  match_score int,
  channel text not null check (channel in ('resend','gmail','manual')),
  recipient text,
  subject text not null default '',
  body_text text not null default '',
  body_html text not null default '',
  job_snapshot jsonb not null default '{}'::jsonb,
  processing_status text not null default 'pendente',
  email_status text,
  selection_status text not null default 'registrada',
  provider_message_id text,
  idempotency_key text not null,
  attempts_count int not null default 0,
  last_error text,
  manual_apply_url text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists career_applications_owner_idx on career_applications (owner_id, processing_status);
create index if not exists career_applications_provider_idx on career_applications (provider_message_id);
-- Uma candidatura viva por candidato e vaga canônica (canceladas não contam).
create unique index if not exists career_applications_profile_job_uq
  on career_applications (profile_id, canonical_key)
  where processing_status <> 'cancelada';

create table if not exists career_attempts (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  application_id text not null,
  number int not null,
  idempotency_key text not null,
  channel text not null,
  outcome text not null,
  provider_message_id text,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists career_attempts_app_idx on career_attempts (application_id);

-- Histórico append-only: sem UPDATE/DELETE via política.
create table if not exists career_events (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  application_id text not null,
  type text not null,
  source text not null,
  detail text,
  provider_event_id text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists career_events_app_idx on career_events (application_id, occurred_at);

create table if not exists career_queue (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pendente',
  attempts int not null default 0,
  max_attempts int not null default 4,
  next_run_at timestamptz not null default now(),
  locked_until timestamptz,
  lock_owner text,
  last_error text,
  progress jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists career_queue_due_idx on career_queue (status, next_run_at, locked_until);
create index if not exists career_queue_owner_idx on career_queue (owner_id, status);

create table if not exists career_connections (
  id text primary key,
  owner_id text not null,
  organization_id text not null,
  provider text not null,
  account_email text not null,
  encrypted_tokens text not null,
  scopes jsonb not null default '[]'::jsonb,
  expires_at timestamptz,
  status text not null default 'ativa',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint career_connections_owner_provider_uq unique (owner_id, provider)
);

create table if not exists career_webhook_receipts (
  id text primary key,
  provider text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: só o titular. Service role (backend/worker) ignora RLS.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'career_profiles','career_resumes','career_analyses','career_link_checks','career_preferences',
    'career_jobs','career_matches','career_campaigns','career_applications','career_attempts',
    'career_events','career_queue','career_connections'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_owner_select', t);
    execute format('create policy %I on %I for select using (auth.uid()::text = owner_id)', t || '_owner_select', t);
    execute format('drop policy if exists %I on %I', t || '_owner_insert', t);
    execute format('create policy %I on %I for insert with check (auth.uid()::text = owner_id)', t || '_owner_insert', t);
    if t not in ('career_events','career_attempts') then
      execute format('drop policy if exists %I on %I', t || '_owner_update', t);
      execute format('create policy %I on %I for update using (auth.uid()::text = owner_id) with check (auth.uid()::text = owner_id)', t || '_owner_update', t);
      execute format('drop policy if exists %I on %I', t || '_owner_delete', t);
      execute format('create policy %I on %I for delete using (auth.uid()::text = owner_id)', t || '_owner_delete', t);
    end if;
  end loop;
end $$;

-- Recibos de webhook não têm titular: só a service role escreve/lê.
alter table career_webhook_receipts enable row level security;

-- ---------------------------------------------------------------------------
-- Storage: bucket privado para os PDFs, objetos sob <owner_id>/…
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('career-resumes', 'career-resumes', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf'];

drop policy if exists "career_resumes_owner_read" on storage.objects;
create policy "career_resumes_owner_read" on storage.objects for select
  using (bucket_id = 'career-resumes' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "career_resumes_owner_write" on storage.objects;
create policy "career_resumes_owner_write" on storage.objects for insert
  with check (bucket_id = 'career-resumes' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "career_resumes_owner_delete" on storage.objects;
create policy "career_resumes_owner_delete" on storage.objects for delete
  using (bucket_id = 'career-resumes' and (storage.foldername(name))[1] = auth.uid()::text);


-- ============================================================
-- 0004_auth.sql — Autenticação real: app_users, convites e gatilho
-- ============================================================

-- Migração 0004 — autenticação real (Supabase Auth).
--
-- Até aqui a sessão era demo: um cookie com o id de um usuário do seed, sem
-- senha. Esta migração cria a ponte entre `auth.users` (gerido pelo Supabase)
-- e o modelo da aplicação:
--
--   * `app_users` guarda nome, e-mail, papel e organização de cada conta.
--     O `id` é o mesmo UUID de `auth.users`, que é o que `auth.uid()` devolve
--     — por isso as políticas de RLS das outras tabelas (inclusive as
--     `career_*` da 0003, que comparam `auth.uid()::text = owner_id`) só
--     passam a valer de verdade depois desta migração.
--   * `app_invites` registra convites por e-mail. Quem se cadastra com um
--     e-mail convidado entra com o papel combinado; quem não foi convidado
--     entra como `viewer`. A primeira conta da instância vira `owner`.
--
-- `organization_id` continua text sem FK, como na 0002/0003: a organização
-- ainda vive no snapshot da aplicação.
--
-- Rode no SQL Editor do Supabase, depois da 0003.

create table if not exists app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id text not null,
  name text not null default '',
  email text not null,
  role text not null default 'viewer' check (role in ('owner','admin','sdr','vendedor','viewer')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists app_users_org_idx on app_users (organization_id);
create unique index if not exists app_users_email_uq on app_users (lower(email));

create table if not exists app_invites (
  email text primary key,
  organization_id text not null,
  name text not null default '',
  role text not null default 'viewer' check (role in ('owner','admin','sdr','vendedor','viewer')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

-- Organização padrão quando não há convite. Igual ao id do snapshot, para
-- que os dados criados no modo demo e em produção falem do mesmo tenant.
create or replace function app_default_organization() returns text
language sql stable as $$ select coalesce(
  (select organization_id from app_users order by created_at limit 1),
  'org_atlas'
) $$;

/**
 * Cria a linha em `app_users` quando alguém se cadastra.
 *
 * Papel: o do convite, se houver; `owner` se for a primeira conta da
 * instância; `viewer` caso contrário — nunca um papel escolhido pelo
 * próprio cadastro, que é entrada não confiável.
 */
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  invite app_invites%rowtype;
  resolved_role text;
  resolved_org text;
  resolved_name text;
begin
  select * into invite from app_invites where lower(email) = lower(new.email);

  if not exists (select 1 from app_users) then
    resolved_role := 'owner';
  elsif invite.email is not null then
    resolved_role := invite.role;
  else
    resolved_role := 'viewer';
  end if;

  resolved_org := coalesce(invite.organization_id, app_default_organization());
  resolved_name := coalesce(
    nullif(invite.name, ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    split_part(new.email, '@', 1)
  );

  insert into app_users (id, organization_id, name, email, role)
  values (new.id, resolved_org, resolved_name, new.email, resolved_role)
  on conflict (id) do nothing;

  if invite.email is not null then
    update app_invites set accepted_at = now() where email = invite.email;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table app_users enable row level security;
alter table app_invites enable row level security;

-- Membros da mesma organização se enxergam (tela de Equipe, atribuição de leads).
drop policy if exists app_users_read_same_org on app_users;
create policy app_users_read_same_org on app_users for select
  using (organization_id = (select organization_id from app_users me where me.id = auth.uid()));

-- Cada um edita o próprio cadastro; o papel é alterado pelo backend
-- (service role), nunca pelo próprio usuário — daí a checagem de role igual.
drop policy if exists app_users_update_self on app_users;
create policy app_users_update_self on app_users for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from app_users me where me.id = auth.uid()));

-- Convites: só owner/admin da organização leem e escrevem.
drop policy if exists app_invites_admin on app_invites;
create policy app_invites_admin on app_invites for all
  using (exists (
    select 1 from app_users me
    where me.id = auth.uid() and me.role in ('owner','admin') and me.organization_id = app_invites.organization_id
  ))
  with check (exists (
    select 1 from app_users me
    where me.id = auth.uid() and me.role in ('owner','admin') and me.organization_id = app_invites.organization_id
  ));


-- ============================================================
-- 0005_agentes.sql — AgentOS: fila, log, nichos e aprovações dos agentes
-- ============================================================

-- Migração 0005 — AgentOS (fila, log, nichos e aprovações dos agentes).
--
-- Mesmas convenções da 0002–0004, pelo mesmo motivo (o resto do CRM ainda vive
-- no snapshot da aplicação):
--
--   * `id` é text, no formato que o app gera (`atk_<hex>`, `nt_<nicho>_<cidade>`…);
--   * `organization_id` é text e sem FK;
--   * o servidor usa a service role, que ignora RLS. As políticas abaixo
--     existem para que, se a anon key um dia chegar ao navegador, ninguém leia
--     dado de outra organização — e só leitura: escrever é papel do servidor.
--
-- Rode no SQL Editor do Supabase, depois da 0004. É idempotente.

-- ---------------------------------------------------------------------------
-- Configuração (inclui a linha especial `global`, o interruptor geral)
-- ---------------------------------------------------------------------------
create table if not exists agent_settings (
  id text not null,
  organization_id text not null,
  mode text not null default 'aprovacao' check (mode in ('pausado','aprovacao','automatico')),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Fila durável (lease + tentativas), no molde de career_queue
-- ---------------------------------------------------------------------------
create table if not exists agent_tasks (
  id text primary key,
  organization_id text not null,
  agent text not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  status text not null default 'pendente' check (status in ('pendente','processando','concluido','falhou','cancelado')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_run_at timestamptz not null default now(),
  locked_until timestamptz,
  lock_owner text,
  last_error text,
  progress jsonb,
  result jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists agent_tasks_due_idx on agent_tasks (status, next_run_at, locked_until);
create index if not exists agent_tasks_agent_idx on agent_tasks (organization_id, agent, created_at desc);
-- A mesma tarefa não pode estar viva duas vezes (a corrida entre duas instâncias termina aqui).
create unique index if not exists agent_tasks_dedupe_live_uq
  on agent_tasks (organization_id, dedupe_key)
  where dedupe_key is not null and status in ('pendente','processando');

-- ---------------------------------------------------------------------------
-- Log estruturado e batimento do runner
-- ---------------------------------------------------------------------------
create table if not exists agent_events (
  id text primary key,
  organization_id text not null,
  agent text not null,
  level text not null default 'info' check (level in ('info','warn','error')),
  type text not null,
  message text not null,
  data jsonb,
  task_id text,
  created_at timestamptz not null default now()
);
create index if not exists agent_events_recent_idx on agent_events (organization_id, created_at desc);
create index if not exists agent_events_agent_idx on agent_events (organization_id, agent, created_at desc);

create table if not exists agent_heartbeats (
  id text primary key,
  organization_id text not null,
  instance text not null,
  started_at timestamptz not null,
  beat_at timestamptz not null,
  info jsonb
);
create index if not exists agent_heartbeats_beat_idx on agent_heartbeats (organization_id, beat_at desc);

-- ---------------------------------------------------------------------------
-- Agente 1: nichos ranqueados
-- ---------------------------------------------------------------------------
create table if not exists niche_targets (
  id text primary key,
  organization_id text not null,
  niche text not null,
  niche_label text not null,
  city text not null,
  state text,
  country text not null default 'Brasil',
  metrics jsonb not null default '{}'::jsonb,
  score int not null default 0,
  factors jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  source text not null,
  status text not null default 'auto' check (status in ('auto','fixado','banido')),
  analyzed_at timestamptz not null default now(),
  valid_until timestamptz not null,
  task_id text
);
create index if not exists niche_targets_rank_idx on niche_targets (organization_id, score desc);

-- ---------------------------------------------------------------------------
-- Aprovações
-- ---------------------------------------------------------------------------
create table if not exists approvals (
  id text primary key,
  organization_id text not null,
  agent text not null,
  kind text not null default 'agent_task',
  title text not null,
  detail text,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  status text not null default 'pendente' check (status in ('pendente','aprovado','recusado','expirado')),
  decided_by text,
  decided_at timestamptz,
  task_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists approvals_pending_idx on approvals (organization_id, status, created_at desc);
create index if not exists approvals_dedupe_idx on approvals (organization_id, dedupe_key);

-- ---------------------------------------------------------------------------
-- Consumo (base dos tetos diários)
-- ---------------------------------------------------------------------------
create table if not exists spend_ledger (
  id text primary key,
  organization_id text not null,
  agent text not null,
  kind text not null check (kind in ('places_requests','leads','llm_tokens')),
  amount numeric not null,
  note text,
  day date not null,
  created_at timestamptz not null default now()
);
create index if not exists spend_ledger_day_idx on spend_ledger (organization_id, agent, kind, day);

-- ---------------------------------------------------------------------------
-- RLS: leitura só da própria organização (via app_users, da 0004).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'agent_settings','agent_tasks','agent_events','agent_heartbeats',
    'niche_targets','approvals','spend_ledger'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;


-- ============================================================
-- 0006_whatsapp.sql — WhatsApp: estado da conexão e recibos dos webhooks
-- ============================================================

-- Migração 0006 — WhatsApp (estado da conexão e recibos dos webhooks do gateway).
--
-- Mesmas convenções da 0005: `id` em text, `organization_id` em text sem FK, o
-- servidor usa a service role e as políticas são só de leitura da própria
-- organização. O gateway de WhatsApp NÃO acessa este banco: ele guarda a sessão
-- e a caixa de saída num SQLite próprio e fala com o CRM por webhook assinado.
-- Estas duas tabelas são o que o CRM guarda do que o gateway lhe contou.
--
-- Rode no SQL Editor do Supabase, depois da 0005. É idempotente.

create table if not exists whatsapp_link (
  id text primary key,                 -- id da sessão no gateway
  organization_id text not null,
  status text not null default 'DISCONNECTED'
    check (status in ('DISCONNECTED','QR','CONNECTING','CONNECTED','NEEDS_RECONNECT')),
  phone text,
  push_name text,
  last_error text,
  dry_run boolean not null default true,
  last_event_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists whatsapp_link_org_idx on whatsapp_link (organization_id);

-- Deduplicação: o gateway reenvia até o CRM confirmar, então o mesmo evento
-- pode chegar mais de uma vez. O id do evento é a chave.
create table if not exists whatsapp_receipts (
  id text primary key,
  organization_id text not null,
  type text not null,
  received_at timestamptz not null default now()
);
create index if not exists whatsapp_receipts_received_idx on whatsapp_receipts (received_at);

do $$
declare t text;
begin
  foreach t in array array['whatsapp_link','whatsapp_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;


-- ============================================================
-- 0007_vendedor.sql — Vendedor: ciclos de envio, mensagens e lista de bloqueio
-- ============================================================

-- Migração 0007 — Vendedor (ciclos de envio, mensagens e lista de bloqueio).
--
-- Mesmas convenções da 0005/0006: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e políticas só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0006. É idempotente.

-- O Vendedor também consulta se um número tem WhatsApp (consumo diário próprio).
alter table spend_ledger drop constraint if exists spend_ledger_kind_check;
alter table spend_ledger
  add constraint spend_ledger_kind_check
  check (kind in ('places_requests','leads','llm_tokens','whatsapp_lookups'));

-- ---------------------------------------------------------------------------
-- Ciclos de envio: agendado → reivindicado → enviado | pulado | falhou | incerto | cancelado
-- ---------------------------------------------------------------------------
create table if not exists outreach_cycles (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  touch int not null check (touch between 1 and 3),
  phone text not null,
  body text not null,
  status text not null default 'agendado'
    check (status in ('agendado','reivindicado','enviado','pulado','falhou','incerto','cancelado')),
  scheduled_for timestamptz not null,
  not_before timestamptz not null,
  claimed_at timestamptz,
  attempts int not null default 0,
  idempotency_key text not null,
  approval_id text,
  skip_reason text,
  last_error text,
  message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
-- A mesma chave nunca gera dois envios.
create unique index if not exists outreach_cycles_idem_uq on outreach_cycles (idempotency_key);
-- Um lead nunca tem duas abordagens ativas ao mesmo tempo (a corrida entre dois processos termina aqui).
create unique index if not exists outreach_cycles_one_active_uq
  on outreach_cycles (organization_id, lead_id)
  where status in ('agendado','reivindicado');
create index if not exists outreach_cycles_due_idx on outreach_cycles (status, not_before);
create index if not exists outreach_cycles_lead_idx on outreach_cycles (organization_id, lead_id, touch);

-- ---------------------------------------------------------------------------
-- Mensagens enviadas e o estado confirmado pelo WhatsApp
-- ---------------------------------------------------------------------------
create table if not exists outreach_messages (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  cycle_id text not null,
  phone text not null,
  body text not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED','SENT','DELIVERED','READ','FAILED','UNCERTAIN')),
  provider_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz
);
create index if not exists outreach_messages_provider_idx on outreach_messages (provider_message_id);
create index if not exists outreach_messages_lead_idx on outreach_messages (organization_id, lead_id, created_at desc);
create index if not exists outreach_messages_sent_idx on outreach_messages (organization_id, sent_at);

-- ---------------------------------------------------------------------------
-- Lista de bloqueio: quem não pode receber mensagem (id = só os dígitos do telefone)
-- ---------------------------------------------------------------------------
create table if not exists channel_blocklist (
  id text primary key,
  organization_id text not null,
  phone text not null,
  reason text not null,
  source text not null default 'manual' check (source in ('manual','opt_out','invalid')),
  created_at timestamptz not null default now()
);
create index if not exists channel_blocklist_org_idx on channel_blocklist (organization_id);

do $$
declare t text;
begin
  foreach t in array array['outreach_cycles','outreach_messages','channel_blocklist'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;


-- ============================================================
-- 0008_conversa.sql — Conversa do Vendedor: estado por lead, reuniões e aviso ao dono
-- ============================================================

-- Migração 0008 — Conversa do Vendedor (estado por lead, reuniões e aviso ao dono).
--
-- Mesmas convenções da 0005–0007: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e políticas só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0007. É idempotente.

-- Ciclos de envio passam a ter dois tipos: abordagem (toques 1 a 3) e resposta a
-- uma mensagem do lead (toque 0). O índice "um ciclo ativo por lead" continua valendo.
alter table outreach_cycles add column if not exists kind text not null default 'abordagem';
alter table outreach_cycles drop constraint if exists outreach_cycles_kind_check;
alter table outreach_cycles
  add constraint outreach_cycles_kind_check check (kind in ('abordagem','resposta'));
alter table outreach_cycles drop constraint if exists outreach_cycles_touch_check;
alter table outreach_cycles
  add constraint outreach_cycles_touch_check check (touch between 0 and 3);

-- ---------------------------------------------------------------------------
-- Estado da conversa por lead (id = id do lead): quem conduz e o que falta.
-- ---------------------------------------------------------------------------
create table if not exists conversation_state (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  control text not null default 'agente' check (control in ('agente','humano')),
  control_reason text,
  awaiting text not null default 'nada' check (awaiting in ('nada','horario','humano')),
  proposed_slots jsonb not null default '[]'::jsonb,
  last_inbound_at timestamptz,
  last_classification text,
  attention_reason text,
  interest_text text,
  interest_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversation_state_org_idx on conversation_state (organization_id, awaiting);

-- ---------------------------------------------------------------------------
-- Reuniões marcadas (pelo agente ou à mão)
-- ---------------------------------------------------------------------------
create table if not exists meetings (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  at timestamptz not null,
  duration_min int not null default 20,
  status text not null default 'agendada' check (status in ('agendada','realizada','cancelada')),
  source text not null default 'agente' check (source in ('agente','manual')),
  interest_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meetings_org_at_idx on meetings (organization_id, at);
create index if not exists meetings_lead_idx on meetings (organization_id, lead_id);

-- ---------------------------------------------------------------------------
-- Aviso ao WhatsApp pessoal do dono (hoje: reunião marcada)
-- ---------------------------------------------------------------------------
create table if not exists owner_notices (
  id text primary key,
  organization_id text not null,
  kind text not null default 'reuniao' check (kind in ('reuniao')),
  lead_id text,
  meeting_id text,
  phone text not null,
  body text not null,
  status text not null default 'pendente' check (status in ('pendente','enviado','falhou','incerto')),
  attempts int not null default 0,
  not_before timestamptz not null,
  provider_message_id text,
  last_error text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists owner_notices_idem_uq on owner_notices (idempotency_key);
create index if not exists owner_notices_due_idx on owner_notices (status, not_before);

do $$
declare t text;
begin
  foreach t in array array['conversation_state','meetings','owner_notices'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;


-- ============================================================
-- 0009_dossie.sql — Dossiê de presença digital (Agente 3)
-- ============================================================

-- Migração 0009 — Dossiê de presença digital (Agente 3).
--
-- Mesmas convenções da 0005–0008: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e política só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0008. É idempotente.

-- O Agente 3 também tem um teto diário próprio: dossiês montados.
alter table spend_ledger drop constraint if exists spend_ledger_kind_check;
alter table spend_ledger
  add constraint spend_ledger_kind_check
  check (kind in ('places_requests','leads','llm_tokens','whatsapp_lookups','dossiers'));

-- ---------------------------------------------------------------------------
-- Um dossiê por lead (id = id do lead), refeito quando passa da validade.
-- `sources`, `findings` e `assessment` são JSON: o formato é o de LeadDossier em
-- src/types/agents.ts. Toda afirmação em `findings` carrega a própria evidência.
-- ---------------------------------------------------------------------------
create table if not exists lead_dossiers (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  status text not null default 'parcial' check (status in ('concluido','parcial')),
  confidence int not null default 0 check (confidence between 0 and 100),
  sources jsonb not null default '[]'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  assessment jsonb,
  headline_problem text,
  summary text not null default '',
  website_quality_before text not null default 'desconhecido',
  website_quality_after text not null default 'desconhecido',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  valid_until timestamptz not null
);
create index if not exists lead_dossiers_org_idx on lead_dossiers (organization_id, valid_until);
create index if not exists lead_dossiers_lead_idx on lead_dossiers (organization_id, lead_id);

alter table lead_dossiers enable row level security;
drop policy if exists lead_dossiers_org_select on lead_dossiers;
create policy lead_dossiers_org_select on lead_dossiers for select
  using (organization_id = (select organization_id from app_users where id = auth.uid()));


-- ============================================================
-- 0010_sites.sql — Prévia de site (Agente 5)
-- ============================================================

-- Migração 0010 — Prévia de site (Agente 5).
--
-- Mesmas convenções da 0005–0009: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e política só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0009. É idempotente.

-- O dossiê passa a guardar o perfil que o site usa (campos comprovados).
alter table lead_dossiers add column if not exists profile jsonb;

-- O aviso ao dono também avisa quando a prévia fica pronta.
alter table owner_notices drop constraint if exists owner_notices_kind_check;
alter table owner_notices
  add constraint owner_notices_kind_check check (kind in ('reuniao','previa'));

-- ---------------------------------------------------------------------------
-- Prévias de site: na_fila → construindo → verificando → pronto | falhou | cancelado
-- Os arquivos ficam no computador (.data/site-previews/<token>); aqui só o registro.
-- ---------------------------------------------------------------------------
create table if not exists site_builds (
  id text primary key,
  organization_id text not null,
  lead_id text not null,
  meeting_id text,
  status text not null default 'na_fila'
    check (status in ('na_fila','construindo','verificando','pronto','falhou','cancelado')),
  builder text not null default 'modelos',
  token text not null,
  content_hash text,
  checks jsonb not null default '[]'::jsonb,
  screenshots jsonb not null default '[]'::jsonb,
  error text,
  deadline_at timestamptz,
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  expires_at timestamptz
);
-- O endereço da prévia é único e nunca se repete.
create unique index if not exists site_builds_token_uq on site_builds (token);
create index if not exists site_builds_lead_idx on site_builds (organization_id, lead_id, created_at desc);
create index if not exists site_builds_status_idx on site_builds (organization_id, status);

alter table site_builds enable row level security;
drop policy if exists site_builds_org_select on site_builds;
create policy site_builds_org_select on site_builds for select
  using (organization_id = (select organization_id from app_users where id = auth.uid()));


-- ============================================================
-- 0011_social_trafego.sql — Mídias sociais (Agente 7) e Gestor de tráfego (Agente 6)
-- ============================================================

-- Migração 0011 — Mídias sociais (Agente 7) e Gestor de tráfego (Agente 6).
--
-- Mesmas convenções da 0005–0010: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e política só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0010. É idempotente.

-- ---------------------------------------------------------------------------
-- Posts do Instagram: rascunho → pendente → aprovado → publicando → publicado | falhou
-- (recusado e expirado encerram sem publicar). Nada publica sem o clique em "Aprovar e publicar".
-- ---------------------------------------------------------------------------
create table if not exists social_posts (
  id text primary key,
  organization_id text not null,
  platform text not null default 'instagram' check (platform in ('instagram')),
  topic text not null,
  caption text not null,
  image_url text,
  image_idea text not null default '',
  status text not null default 'pendente'
    check (status in ('rascunho','pendente','aprovado','publicando','publicado','falhou','recusado','expirado')),
  approval_id text,
  idempotency_key text not null,
  external_id text,
  permalink text,
  error text,
  uncertain boolean not null default false,
  edited boolean not null default false,
  approved_by text,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
-- O mesmo post nunca publica duas vezes.
create unique index if not exists social_posts_idem_uq on social_posts (idempotency_key);
create index if not exists social_posts_status_idx on social_posts (organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Campanhas de anúncio: nascem rascunho; ativar e aumentar orçamento exigem clique, dentro dos tetos.
-- Dinheiro sempre em centavos.
-- ---------------------------------------------------------------------------
create table if not exists ad_campaigns (
  id text primary key,
  organization_id text not null,
  name text not null,
  objective text not null check (objective in ('mensagens','trafego','reconhecimento','leads')),
  platform text not null default 'manual' check (platform in ('manual','meta','google')),
  status text not null default 'pendente'
    check (status in ('rascunho','pendente','aprovado','ativa','pausada','encerrada','recusada','expirada','falhou')),
  daily_budget_cents bigint not null check (daily_budget_cents >= 0),
  start_date date not null,
  end_date date,
  audience text not null default '',
  headline text not null default '',
  body text not null default '',
  cta text not null default '',
  landing_url text,
  approval_id text,
  external_id text,
  idempotency_key text not null,
  error text,
  approved_by text,
  approved_at timestamptz,
  activated_by text,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create unique index if not exists ad_campaigns_idem_uq on ad_campaigns (idempotency_key);
create index if not exists ad_campaigns_status_idx on ad_campaigns (organization_id, status);

-- Desempenho por campanha por dia (id = '<campanha>:<dia>').
create table if not exists ad_reports (
  id text primary key,
  organization_id text not null,
  campaign_id text not null,
  day date not null,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  spend_cents bigint not null default 0,
  conversions bigint not null default 0,
  source text not null default 'manual' check (source in ('manual','provider')),
  created_at timestamptz not null default now()
);
create index if not exists ad_reports_day_idx on ad_reports (organization_id, day);

do $$
declare t text;
begin
  foreach t in array array['social_posts','ad_campaigns','ad_reports'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;
