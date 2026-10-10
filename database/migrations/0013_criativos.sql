-- Migração 0013 — Criativos (imagens e vídeos da própria empresa) e calendário editorial.
--
-- Mesmas convenções da 0005–0012: `id` em text, `organization_id` em text sem FK,
-- servidor com service role e política só de leitura da própria organização.
--
-- Rode no SQL Editor do Supabase, depois da 0012. É idempotente.

-- ---------------------------------------------------------------------------
-- Criativos: HTML/SVG renderizado localmente (PNG) e vídeo por cenas + ffmpeg (MP4).
-- Só são servidos de fora (/midia/<token>/…) depois de aprovados.
-- ---------------------------------------------------------------------------
create table if not exists creatives (
  id text primary key,
  organization_id text not null,
  format text not null check (format in ('feed','story','reel','anuncio')),
  kind text not null check (kind in ('imagem','video')),
  owner_kind text not null check (owner_kind in ('post','campaign')),
  owner_id text not null,
  status text not null default 'pendente'
    check (status in ('pendente','aprovado','recusado','expirado','falhou')),
  width int not null,
  height int not null,
  duration_s numeric,
  headline text not null default '',
  body text not null default '',
  cta text not null default '',
  builder text not null default 'modelos' check (builder in ('modelos','claude-code')),
  variant int not null default 0,
  token text not null,
  files jsonb not null default '[]'::jsonb,
  content_hash text,
  checks jsonb not null default '[]'::jsonb,
  error text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create unique index if not exists creatives_token_uq on creatives (token);
create index if not exists creatives_owner_idx on creatives (organization_id, owner_kind, owner_id, created_at desc);

alter table creatives enable row level security;
drop policy if exists creatives_org_select on creatives;
create policy creatives_org_select on creatives for select
  using (organization_id = (select organization_id from app_users where id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Posts: formato (Feed, Reels, Stories), criativo, sugestão de horário e agendamento.
-- "Aprovar e agendar" leva pendente → agendado; o publicador reconfere tudo antes de sair.
-- ---------------------------------------------------------------------------
alter table social_posts add column if not exists format text not null default 'feed';
alter table social_posts drop constraint if exists social_posts_format_check;
alter table social_posts add constraint social_posts_format_check check (format in ('feed','reel','story'));
alter table social_posts add column if not exists creative_id text;
alter table social_posts add column if not exists suggested_at timestamptz;
alter table social_posts add column if not exists scheduled_at timestamptz;
alter table social_posts add column if not exists approved_digest text;

alter table social_posts drop constraint if exists social_posts_status_check;
alter table social_posts add constraint social_posts_status_check
  check (status in ('rascunho','pendente','aprovado','agendado','publicando','publicado','falhou','recusado','expirado'));
create index if not exists social_posts_scheduled_idx on social_posts (scheduled_at) where status = 'agendado';

-- ---------------------------------------------------------------------------
-- Campanhas: o criativo (imagem) do anúncio. Com ele, ativar exige a imagem aprovada.
-- ---------------------------------------------------------------------------
alter table ad_campaigns add column if not exists creative_id text;
