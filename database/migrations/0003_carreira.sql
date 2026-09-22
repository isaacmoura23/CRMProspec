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
