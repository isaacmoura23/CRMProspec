import { NextResponse, type NextRequest } from "next/server";
import { readPreview } from "@/services/sites/build";

/**
 * Prévia pública de um site (`/previa/<token>`).
 *
 * Pública para o proxy (quem recebe o endereço não tem conta), mas o endereço é um
 * token aleatório de 192 bits — não dá para adivinhar, e a prévia deixa de abrir
 * quando é descartada ou expira. A resposta pede para ficar fora dos buscadores e
 * não executa nada: CSP sem script e sem recursos externos.
 */
export const dynamic = "force-dynamic";

const COMMON = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const html = await readPreview(token);
  if (!html) return new NextResponse("Prévia não encontrada ou expirada.", { status: 404, headers: { ...COMMON, "Content-Type": "text/plain; charset=utf-8" } });
  return new NextResponse(html, {
    status: 200,
    headers: {
      ...COMMON,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
