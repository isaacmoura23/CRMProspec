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
