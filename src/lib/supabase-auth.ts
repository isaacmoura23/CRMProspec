import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User as AuthUser } from "@supabase/supabase-js";

/**
 * Cliente Supabase ligado à sessão do visitante.
 *
 * Diferente de `lib/supabase.ts` (service role, usado por jobs e webhooks,
 * que ignora RLS), este usa a anon key e os cookies da requisição: é a
 * identidade do usuário que chega ao banco, então as políticas de RLS valem.
 *
 * Um cliente novo por requisição, nunca compartilhado — a orientação é
 * explícita na documentação do @supabase/ssr, e reaproveitar o cliente entre
 * requisições vaza sessão de um usuário para outro.
 */

export function isSupabaseAuthConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * `setAll` falha em Server Components (só actions e route handlers podem
 * escrever cookies). Isso é esperado: o refresh do token acontece no
 * `proxy.ts`, que roda antes e grava os cookies na resposta.
 */
export async function createSessionClient(): Promise<SupabaseClient | null> {
  if (!isSupabaseAuthConfigured()) return null;
  const jar = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) jar.set(name, value, options);
        } catch {
          /* Server Component: o proxy já cuidou do refresh. */
        }
      },
    },
  });
}

/**
 * Usuário autenticado, ou `null`.
 *
 * `getClaims()` valida a assinatura do JWT localmente (JWKS em cache) quando
 * o projeto usa chaves assimétricas, o que evita uma ida à rede por
 * requisição; em projetos com segredo simétrico ele mesmo consulta o
 * servidor, como `getUser()` faria. Em qualquer caso a validação é do
 * servidor — nunca confiamos no cookie sem verificar.
 */
export async function getAuthUser(): Promise<{ id: string; email: string } | null> {
  const supabase = await createSessionClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (!error && data?.claims?.sub) {
      const claims = data.claims as { sub: string; email?: string };
      return { id: claims.sub, email: claims.email ?? "" };
    }
  } catch {
    /* cai para getUser abaixo */
  }
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? "" };
}

export type { AuthUser };
