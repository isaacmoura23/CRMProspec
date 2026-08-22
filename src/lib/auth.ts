import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/store";
import type { User } from "@/types";

/**
 * Autenticação.
 *
 * Produção: Supabase Auth (@supabase/ssr) — habilitada quando
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY existirem.
 * Modo demo: sessão via cookie assinando o usuário semente.
 */

const SESSION_COOKIE = "crm_session_user";

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** Usuário da sessão atual, ou `null` quando não há sessão válida. */
export async function getSessionUser(): Promise<User | null> {
  const jar = await cookies();
  const userId = jar.get(SESSION_COOKIE)?.value;
  if (!userId) return null;
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
  return user.role === "owner" || user.role === "admin" ? user : null;
}

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
