-- Migração 0004 — autenticação real (Supabase Auth).
--
-- Até aqui a sessão era demo: um cookie com o id de um usuário do seed, sem
-- senha. Esta migração cria a ponte entre `auth.users` (gerido pelo Supabase)
-- e o modelo da aplicação:
--
--   * `app_users` guarda nome, e-mail, papel e organização de cada conta.
--     O `id` é o mesmo UUID de `auth.users`, que é o que `auth.uid()` devolve
--     — por isso as políticas de RLS das outras tabelas (inclusive as
--     `career_*` da 0003, que comparam `auth.uid()::text = owner_id`) só
--     passam a valer de verdade depois desta migração.
--   * `app_invites` registra convites por e-mail. Quem se cadastra com um
--     e-mail convidado entra com o papel combinado; quem não foi convidado
--     entra como `viewer`. A primeira conta da instância vira `owner`.
--
-- `organization_id` continua text sem FK, como na 0002/0003: a organização
-- ainda vive no snapshot da aplicação.
--
-- Rode no SQL Editor do Supabase, depois da 0003.

create table if not exists app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id text not null,
  name text not null default '',
  email text not null,
  role text not null default 'viewer' check (role in ('owner','admin','sdr','vendedor','viewer')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists app_users_org_idx on app_users (organization_id);
create unique index if not exists app_users_email_uq on app_users (lower(email));

create table if not exists app_invites (
  email text primary key,
  organization_id text not null,
  name text not null default '',
  role text not null default 'viewer' check (role in ('owner','admin','sdr','vendedor','viewer')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

-- Organização padrão quando não há convite. Igual ao id do snapshot, para
-- que os dados criados no modo demo e em produção falem do mesmo tenant.
create or replace function app_default_organization() returns text
language sql stable as $$ select coalesce(
  (select organization_id from app_users order by created_at limit 1),
  'org_atlas'
) $$;

/**
 * Cria a linha em `app_users` quando alguém se cadastra.
 *
 * Papel: o do convite, se houver; `owner` se for a primeira conta da
 * instância; `viewer` caso contrário — nunca um papel escolhido pelo
 * próprio cadastro, que é entrada não confiável.
 */
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  invite app_invites%rowtype;
  resolved_role text;
  resolved_org text;
  resolved_name text;
begin
  select * into invite from app_invites where lower(email) = lower(new.email);

  if not exists (select 1 from app_users) then
    resolved_role := 'owner';
  elsif invite.email is not null then
    resolved_role := invite.role;
  else
    resolved_role := 'viewer';
  end if;

  resolved_org := coalesce(invite.organization_id, app_default_organization());
  resolved_name := coalesce(
    nullif(invite.name, ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    split_part(new.email, '@', 1)
  );

  insert into app_users (id, organization_id, name, email, role)
  values (new.id, resolved_org, resolved_name, new.email, resolved_role)
  on conflict (id) do nothing;

  if invite.email is not null then
    update app_invites set accepted_at = now() where email = invite.email;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table app_users enable row level security;
alter table app_invites enable row level security;

-- Membros da mesma organização se enxergam (tela de Equipe, atribuição de leads).
drop policy if exists app_users_read_same_org on app_users;
create policy app_users_read_same_org on app_users for select
  using (organization_id = (select organization_id from app_users me where me.id = auth.uid()));

-- Cada um edita o próprio cadastro; o papel é alterado pelo backend
-- (service role), nunca pelo próprio usuário — daí a checagem de role igual.
drop policy if exists app_users_update_self on app_users;
create policy app_users_update_self on app_users for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from app_users me where me.id = auth.uid()));

-- Convites: só owner/admin da organização leem e escrevem.
drop policy if exists app_invites_admin on app_invites;
create policy app_invites_admin on app_invites for all
  using (exists (
    select 1 from app_users me
    where me.id = auth.uid() and me.role in ('owner','admin') and me.organization_id = app_invites.organization_id
  ))
  with check (exists (
    select 1 from app_users me
    where me.id = auth.uid() and me.role in ('owner','admin') and me.organization_id = app_invites.organization_id
  ));
