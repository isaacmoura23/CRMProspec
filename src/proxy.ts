import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isPublicPath } from "@/lib/auth-routes";

/**
 * Renovação da sessão e checagem otimista de acesso.
 *
 * `middleware.ts` foi renomeado para `proxy.ts` no Next 16; a função e o
 * matcher são os mesmos.
 *
 * Duas responsabilidades, nesta ordem:
 *
 * 1. Chamar o Supabase cedo na requisição para que um token prestes a
 *    expirar seja renovado e os cookies novos entrem na resposta. Server
 *    Components não podem escrever cookies, então sem isto a sessão morre
 *    sozinha depois de uma hora.
 * 2. Redirecionar quem não tem sessão para /login e quem já tem para longe
 *    do /login. É uma checagem otimista: a decisão que vale é a de
 *    `getCurrentUser()`, junto dos dados. O proxy roda até em prefetch, por
 *    isso aqui não há consulta a banco.
 */

export default async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Sem Supabase Auth o app está em modo demo: a sessão é o cookie próprio e
  // quem decide é `getCurrentUser()`.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // Resposta que renova token não pode ser cacheada por CDN: serviria
        // a sessão de uma pessoa para outra.
        for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const { pathname } = request.nextUrl;

  if (!signedIn && !isPublicPath(pathname)) {
    const login = new URL("/login", request.url);
    if (pathname !== "/") login.searchParams.set("proximo", pathname);
    return NextResponse.redirect(login);
  }
  if (signedIn && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  return response;
}

export const config = {
  matcher: [
    // Tudo, menos estáticos e imagens — sem isso o redirecionamento de
    // autenticação bloquearia CSS, JS e favicon.
    "/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
