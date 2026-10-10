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
