import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { panelCreativeFile } from "@/services/creatives/engine";
import { serveFile } from "@/services/creatives/serve";

/** Mídia de um criativo para o painel do CRM (prévia antes de aprovar). Exige sessão. */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; file: string }> }) {
  await getCurrentUser();
  const { id, file } = await ctx.params;
  const ref = await panelCreativeFile(id, file);
  if (!ref) return new Response("Não encontrada.", { status: 404 });
  return serveFile(ref, req.headers.get("range"), { "Cache-Control": "private, no-store" });
}
