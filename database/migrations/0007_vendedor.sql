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
