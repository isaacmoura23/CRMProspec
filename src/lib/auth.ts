import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/store";
import { isSupabaseAuthConfigured, getAuthUser } from "@/lib/supabase-auth";
import { ensureLeadsLoaded } from "@/services/lead-repository";
import { canAdminister, canWrite } from "@/lib/permissions";
import { loadAuthenticatedUser } from "@/services/user-repository";
import type { User } from "@/types";

/**
 * Autenticação.
 *
 * Produção: Supabase Auth. A sessão vem dos cookies, o JWT é validado no
 * servidor e o usuário da aplicação (papel, organização) sai de `app_users`
 * — o id é o UUID de `auth.uid()`, que é o que as políticas de RLS comparam.
 *
 * Modo demo (sem NEXT_PUBLIC_SUPABASE_URL/ANON_KEY): cookie com o id de um
 * usuário do seed, sem senha. Serve para navegar o produto sem infraestrutura
 * e está declarado como tal na interface — nunca deve receber dado real.
 */

const SESSION_COOKIE = "crm_session_user";

export function isSupabaseConfigured(): boolean {
  return isSupabaseAuthConfigured();
}

/** Usuário da sessão atual, ou `null` quando não há sessão válida. */
export async function getSessionUser(): Promise<User | null> {
  if (isSupabaseAuthConfigured()) {
    const auth = await getAuthUser();
    if (!auth) return null;
    // Só depois de haver sessão: é o ponto em que os leads do Supabase
    // entram no snapshot, e uma visita anônima não precisa disso.
    await ensureLeadsLoaded();
    return loadAuthenticatedUser(auth);
  }

  const jar = await cookies();
  const userId = jar.get(SESSION_COOKIE)?.value;
  if (!userId) return null;
  await ensureLeadsLoaded();
  return getDb().users.find((u) => u.id === userId) ?? null;
}

/**
 * Usuário da sessão, exigindo autenticação.
 *
 * Antes esta função caía no owner da organização quando não havia cookie,
 * o que deixava toda a aplicação (e todas as server actions) acessíveis
 * anonimamente com privilégio máximo.
 */
export async function getCurrentUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Usuário da sessão, exigindo permissão administrativa.
 *
 * Devolve `null` para quem não é owner/admin, para a action decidir a
 * mensagem de erro. Sem isso, um `viewer` conseguia convidar membros,
 * promover a si mesmo e alterar as configurações da organização.
 */
export async function getAdminUser(): Promise<User | null> {
  const user = await getCurrentUser();
  return canAdminister(user.role) ? user : null;
}

/** Sessão do modo demo. Não é usada quando o Supabase Auth está ativo. */
export async function setSessionUser(userId: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/**
 * Usuário da sessão com permissão de escrita (tudo menos `viewer`).
 *
 * Devolve `null` para somente-leitura, para a action escolher a mensagem.
 * Antes, qualquer sessão autenticada escrevia: com papéis reais vindos do
 * banco, um `viewer` conseguia criar lead, mover etapa e apagar tarefa.
 */
export async function getWriterUser(): Promise<User | null> {
  const user = await getCurrentUser();
  return canWrite(user.role) ? user : null;
}
