import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prospectCsv, prospectRows } from "@/services/prospecting/list";

/** Exporta a lista de prospecção (empresas sem site) em CSV. Exige sessão. */
export const dynamic = "force-dynamic";

export async function GET() {
  await getCurrentUser();
  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(prospectCsv(prospectRows()), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="prospeccao-${day}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
