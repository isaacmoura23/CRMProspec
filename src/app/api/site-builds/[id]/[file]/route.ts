import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readScreenshot } from "@/services/sites/build";

/** Captura de tela de uma prévia, só para quem tem sessão (o painel do CRM). */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; file: string }> }) {
  await getCurrentUser();
  const { id, file } = await ctx.params;
  const png = await readScreenshot(id, file);
  if (!png) return new NextResponse("Não encontrada.", { status: 404 });
  return new NextResponse(new Uint8Array(png), { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
