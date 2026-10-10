import { type NextRequest } from "next/server";
import { publicCreativeFile } from "@/services/creatives/engine";
import { serveFile } from "@/services/creatives/serve";

/**
 * Mídia de um criativo (`/midia/<token>/creative.png|creative.mp4|poster.png`), para o Instagram buscar.
 *
 * Pública para o proxy (quem busca não tem conta), mas o endereço é um token aleatório de 192 bits e só
 * serve criativo APROVADO e dentro do prazo: antes do clique, ou depois de expirar, responde 404.
 * Fora dos buscadores, sem cache, sem tipo adivinhado pelo navegador.
 */
export const dynamic = "force-dynamic";

const HEADERS = { "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Disposition": "inline" };

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await ctx.params;
  const ref = await publicCreativeFile(token, file);
  if (!ref) return new Response("Mídia não encontrada ou expirada.", { status: 404, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  return serveFile(ref, req.headers.get("range"), HEADERS);
}
