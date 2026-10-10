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
