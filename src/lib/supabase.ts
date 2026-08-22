import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase do servidor.
 *
 * Usa a service role key quando disponível: as escritas acontecem em server
 * actions e jobs, onde o tenant já foi resolvido pela sessão. A anon key
 * serve de fallback para leitura.
 *
 * Devolve `null` quando não há credenciais — é o que mantém o modo demo
 * funcionando sem Supabase configurado.
 */

type GlobalWithSupabase = typeof globalThis & { __crmSupabase?: SupabaseClient | null };

export function isSupabaseEnabled(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );
}

export function getSupabase(): SupabaseClient | null {
  const g = globalThis as GlobalWithSupabase;
  if (g.__crmSupabase !== undefined) return g.__crmSupabase;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    g.__crmSupabase = null;
    return null;
  }

  g.__crmSupabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "prospecatlas" } },
  });
  return g.__crmSupabase;
}
