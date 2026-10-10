-- Migração 0012 — Cobertura da varredura do Prospectador (Agente 2).
--
-- Mesmas convenções da 0005–0011: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e política só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0011. É idempotente.

-- O que já foi varrido de um nicho em uma cidade (id = '<nicho>|<cidade sem acento>').
create table if not exists prospect_coverage (
  id text primary key,
  organization_id text not null,
  niche text not null,
  niche_label text not null,
  city text not null,
  state text,
  country text not null default 'Brasil',
  runs int not null default 0,
  scanned int not null default 0,
  found int not null default 0,
  filtered int not null default 0,
  duplicates int not null default 0,
  places_requests int not null default 0,
  last_run_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospect_coverage_org_idx on prospect_coverage (organization_id, last_run_at desc);

alter table prospect_coverage enable row level security;
drop policy if exists prospect_coverage_org_select on prospect_coverage;
create policy prospect_coverage_org_select on prospect_coverage for select
  using (organization_id = (select organization_id from app_users where id = auth.uid()));
