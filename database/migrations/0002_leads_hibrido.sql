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
