import "server-only";
import { getDb, saveDb } from "@/lib/store";
import { getSupabase, isSupabaseEnabled } from "@/lib/supabase";
import type { Role, User } from "@/types";

/**
 * Usuários da aplicação quando a autenticação real está ativa.
 *
 * `app_users` (migração 0004) é a fonte de verdade de nome, e-mail, papel e
 * organização; `auth.users` guarda só a credencial. O snapshot continua
 * existindo porque o resto do domínio (atribuição de leads, notas, tarefas,
 * notificações, tela de Equipe) lê `db.users` como um array síncrono — então
 * os membros são espelhados para lá a cada requisição autenticada, com o
 * mesmo UUID que `auth.uid()` devolve.
 *
 * Esse UUID é o que amarra tudo: é ele que vai em `owner_id` no módulo
 * Carreira e o que as políticas de RLS comparam.
 */

const TABLE_USERS = "app_users";
const TABLE_INVITES = "app_invites";

/**
 * Cache curto por instância.
 *
 * `getSessionUser()` roda em toda página e em toda action; sem cache, cada
 * requisição faria duas consultas ao banco e uma gravação do snapshot em
 * disco. A janela é pequena para que mudança de papel apareça logo, e a
 * chave é o id do usuário — nada é compartilhado entre contas.
 */
const CACHE_TTL_MS = 20_000;
type GlobalWithUserCache = typeof globalThis & { __crmUserCache?: Map<string, { user: User; at: number }> };

function cache(): Map<string, { user: User; at: number }> {
  const g = globalThis as GlobalWithUserCache;
  if (!g.__crmUserCache) g.__crmUserCache = new Map();
  return g.__crmUserCache;
}

/** Chamado depois de alterar papel/perfil, para a mudança valer na hora. */
export function invalidateUserCache(userId?: string) {
  if (userId) cache().delete(userId);
  else cache().clear();
}

interface AppUserRow {
  id: string;
  organization_id: string;
  name: string;
  email: string;
  role: Role;
  avatar_url: string | null;
  created_at: string;
}

function toUser(row: AppUserRow): User {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name || row.email.split("@")[0]!,
    email: row.email,
    role: row.role,
    avatar_url: row.avatar_url,
    created_at: row.created_at,
  };
}

/** Coloca o membro no snapshot sem duplicar (por id). */
function mirror(user: User): User {
  const db = getDb();
  const index = db.users.findIndex((u) => u.id === user.id);
  if (index >= 0) db.users[index] = { ...db.users[index], ...user };
  else db.users.push(user);
  return user;
}

/**
 * Carrega o usuário autenticado a partir de `app_users`.
 *
 * Se a linha não existir — migração 0004 não rodada, ou conta criada antes
 * dela — ela é criada aqui, com o mesmo critério do trigger: a primeira
 * conta vira `owner`, um e-mail convidado recebe o papel do convite, o resto
 * entra como `viewer`. Papel nunca vem do cliente.
 */
export async function loadAuthenticatedUser(auth: { id: string; email: string }): Promise<User | null> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseEnabled()) return null;
  const db = getDb();

  const cached = cache().get(auth.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // O snapshot desta instância pode ter sido recriado (cold start) desde
    // que o cache foi preenchido, então o espelho é reafirmado.
    mirror(cached.user);
    return cached.user;
  }

  const { data, error } = await supabase.from(TABLE_USERS).select("*").eq("id", auth.id).maybeSingle();
  if (error) {
    console.error("[auth] falha ao carregar app_users:", error.message);
    // Sem a tabela não dá para resolver papel/organização com segurança.
    return null;
  }
  if (data) {
    const user = mirror(toUser(data as AppUserRow));
    await mirrorTeam(user.organization_id);
    saveDb();
    cache().set(user.id, { user, at: Date.now() });
    return user;
  }

  const [{ count }, invite] = await Promise.all([
    supabase.from(TABLE_USERS).select("id", { count: "exact", head: true }),
    supabase.from(TABLE_INVITES).select("*").ilike("email", auth.email).maybeSingle(),
  ]);
  const inviteRow = invite.data as { organization_id: string; name: string; role: Role } | null;
  const row: AppUserRow = {
    id: auth.id,
    organization_id: inviteRow?.organization_id ?? db.organization.id,
    name: inviteRow?.name || auth.email.split("@")[0]!,
    email: auth.email,
    role: (count ?? 0) === 0 ? "owner" : (inviteRow?.role ?? "viewer"),
    avatar_url: null,
    created_at: new Date().toISOString(),
  };
  const { error: insertError } = await supabase.from(TABLE_USERS).upsert(row, { onConflict: "id" });
  if (insertError) {
    console.error("[auth] falha ao criar app_users:", insertError.message);
    return null;
  }
  if (inviteRow) await supabase.from(TABLE_INVITES).update({ accepted_at: new Date().toISOString() }).ilike("email", auth.email);

  const user = mirror(toUser(row));
  await mirrorTeam(user.organization_id);
  saveDb();
  cache().set(user.id, { user, at: Date.now() });
  return user;
}

/** Espelha os membros da organização no snapshot (tela de Equipe, atribuições). */
export async function mirrorTeam(organizationId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { data, error } = await supabase.from(TABLE_USERS).select("*").eq("organization_id", organizationId);
  if (error || !data) return;
  const db = getDb();
  const rows = (data as AppUserRow[]).map(toUser);
  // Usuários do seed convivem com os reais até serem substituídos: some com
  // eles assim que houver pelo menos uma conta autenticada na organização.
  db.users = rows.length > 0 ? rows : db.users;
}

/**
 * As escritas abaixo devolvem o erro em vez de apenas registrá-lo.
 *
 * Quando `app_users` e a fonte de verdade, uma escrita recusada pelo banco
 * (politica de RLS, e-mail duplicado, tabela ausente) significa que a
 * alteracao se perde no proximo carregamento — e, antes disto, a action
 * concluia e a interface dizia "salvo".
 */
export async function persistUserProfile(userId: string, patch: { name?: string; email?: string }): Promise<{ error?: string }> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseEnabled()) return {};
  const update: Record<string, string> = { updated_at: new Date().toISOString() };
  if (patch.name) update.name = patch.name;
  if (patch.email) update.email = patch.email;
  const { error } = await supabase.from(TABLE_USERS).update(update).eq("id", userId);
  invalidateUserCache(userId);
  if (error) {
    console.error("[auth] falha ao atualizar perfil:", error.message);
    return { error: error.code === "23505" ? "Ja existe uma conta com este e-mail." : `O banco recusou a alteracao: ${error.message}` };
  }
  return {};
}

export async function persistMemberRole(userId: string, role: Role): Promise<{ error?: string }> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseEnabled()) return {};
  const { data, error } = await supabase
    .from(TABLE_USERS)
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .select("id");
  invalidateUserCache(userId);
  if (error) {
    console.error("[auth] falha ao atualizar papel:", error.message);
    return { error: `O banco recusou a alteracao de papel: ${error.message}` };
  }
  // Zero linhas = o id nao existe em app_users (membro so do snapshot) ou a
  // politica recusou. Nos dois casos o papel NAO mudou no banco.
  if ((data?.length ?? 0) === 0) return { error: "O papel nao foi alterado no banco: esta pessoa ainda nao criou a conta." };
  return {};
}

/**
 * Registra o convite. Quem se cadastrar com esse e-mail recebe o papel
 * combinado — é o que impede que qualquer pessoa que descubra a URL entre
 * como vendedor em vez de `viewer`.
 */
export async function persistInvite(invite: { email: string; name: string; role: Role; organizationId: string; invitedBy: string }): Promise<{ error?: string }> {
  const supabase = getSupabase();
  if (!supabase || !isSupabaseEnabled()) return { error: "Supabase nao esta configurado no servidor." };
  const { error } = await supabase.from(TABLE_INVITES).upsert(
    {
      email: invite.email.toLowerCase(),
      organization_id: invite.organizationId,
      name: invite.name,
      role: invite.role,
      invited_by: invite.invitedBy,
      accepted_at: null,
    },
    { onConflict: "email" }
  );
  if (error) {
    console.error("[auth] falha ao registrar convite:", error.message);
    return { error: `O convite nao foi registrado: ${error.message}` };
  }
  return {};
}
