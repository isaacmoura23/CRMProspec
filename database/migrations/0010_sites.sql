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
