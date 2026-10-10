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
