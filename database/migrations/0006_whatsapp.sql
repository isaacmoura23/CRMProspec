-- Migração 0006 — WhatsApp (estado da conexão e recibos dos webhooks do gateway).
--
-- Mesmas convenções da 0005: `id` em text, `organization_id` em text sem FK, o
-- servidor usa a service role e as políticas são só de leitura da própria
-- organização. O gateway de WhatsApp NÃO acessa este banco: ele guarda a sessão
-- e a caixa de saída num SQLite próprio e fala com o CRM por webhook assinado.
-- Estas duas tabelas são o que o CRM guarda do que o gateway lhe contou.
--
-- Rode no SQL Editor do Supabase, depois da 0005. É idempotente.

create table if not exists whatsapp_link (
  id text primary key,                 -- id da sessão no gateway
  organization_id text not null,
  status text not null default 'DISCONNECTED'
    check (status in ('DISCONNECTED','QR','CONNECTING','CONNECTED','NEEDS_RECONNECT')),
  phone text,
  push_name text,
  last_error text,
  dry_run boolean not null default true,
  last_event_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists whatsapp_link_org_idx on whatsapp_link (organization_id);

-- Deduplicação: o gateway reenvia até o CRM confirmar, então o mesmo evento
-- pode chegar mais de uma vez. O id do evento é a chave.
create table if not exists whatsapp_receipts (
  id text primary key,
  organization_id text not null,
  type text not null,
  received_at timestamptz not null default now()
);
create index if not exists whatsapp_receipts_received_idx on whatsapp_receipts (received_at);

do $$
declare t text;
begin
  foreach t in array array['whatsapp_link','whatsapp_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_select', t);
    execute format(
      'create policy %I on %I for select using (organization_id = (select organization_id from app_users where id = auth.uid()))',
      t || '_org_select', t
    );
  end loop;
end $$;
