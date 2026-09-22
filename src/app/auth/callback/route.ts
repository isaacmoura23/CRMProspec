import { NextResponse, type NextRequest } from "next/server";
import { createSessionClient } from "@/lib/supabase-auth";
import { safeNextPath } from "@/lib/auth-routes";

export const dynamic = "force-dynamic";

/**
 * Destino dos links enviados por e-mail: confirmação de cadastro, link
 * mágico e redefinição de senha.
 *
 * Dois formatos convivem: `?code=` (PKCE) e `?token_hash=&type=` (links de
 * e-mail do Supabase). Os dois trocam o código por uma sessão em cookie.
 *
 * `proximo` só aceita caminho interno (ver `safeNextPath`) — um destino
 * absoluto viraria redirect aberto.
 */

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("proximo"));
  const supabase = await createSessionClient();
  if (!supabase) return NextResponse.redirect(new URL("/login", request.url));

  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");

  let message: string | null = null;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    message = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "signup" | "magiclink" | "recovery" | "invite" | "email_change",
      token_hash: tokenHash,
    });
    message = error?.message ?? null;
  } else {
    message = params.get("error_description") ?? "Link inválido ou expirado.";
  }

  if (message) {
    const login = new URL("/login", request.url);
    login.searchParams.set("erro", message);
    return NextResponse.redirect(login);
  }
  return NextResponse.redirect(new URL(next, request.url));
}
