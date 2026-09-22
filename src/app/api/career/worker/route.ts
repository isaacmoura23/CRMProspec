import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import "@/services/career/handlers";
import { runCareerWorker } from "@/services/career/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Execução do worker por agendador externo (Vercel Cron, cron-job.org…).
 * Exige `Authorization: Bearer <CAREER_WORKER_SECRET>`; a Vercel envia esse
 * cabeçalho automaticamente quando CRON_SECRET está definido — aceitamos os
 * dois nomes. Sem segredo configurado, a rota fica desativada.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CAREER_WORKER_SECRET ?? process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  const report = await runCareerWorker({ budgetMs: 240_000, maxJobs: 50 });
  return NextResponse.json(report);
}

export const POST = GET;
