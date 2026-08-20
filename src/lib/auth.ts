import "server-only";
import { cookies } from "next/headers";
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

export async function getCurrentUser(): Promise<User> {
  const db = getDb();
  const jar = await cookies();
  const userId = jar.get(SESSION_COOKIE)?.value;
  const user = db.users.find((u) => u.id === userId);
  // Modo demo: sem sessão explícita, opera como o owner da organização.
  return user ?? db.users.find((u) => u.role === "owner") ?? db.users[0];
}

export async function setSessionUser(userId: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
