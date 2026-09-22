import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { ownerOf, resumeBytes } from "@/services/career/service";

export const dynamic = "force-dynamic";

/** Download autenticado: só o titular alcança o próprio PDF. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "não autenticado" }, { status: 401 });
  const { id } = await ctx.params;
  const file = await resumeBytes(ownerOf(user), id);
  if (!file) return NextResponse.json({ error: "não encontrado" }, { status: 404 });
  const safeName = file.fileName.replace(/[^\w.\- ]+/g, "_");
  return new NextResponse(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
