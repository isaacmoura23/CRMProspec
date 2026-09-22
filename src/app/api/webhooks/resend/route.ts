import { NextResponse, type NextRequest } from "next/server";
import { verifySvixSignature } from "@/lib/crypto";
import { processResendEvent, type ResendEvent } from "@/services/career/webhook";

/**
 * Webhook do Resend (eventos de entrega).
 *
 * A assinatura é verificada sobre o corpo bruto, com tolerância de 5 min
 * no timestamp (replay). Sem RESEND_WEBHOOK_SECRET o endpoint recusa tudo:
 * um webhook aberto permitiria forjar "entregue" em qualquer candidatura.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook não configurado" }, { status: 503 });

  const raw = await req.text();
  const check = verifySvixSignature(
    secret,
    { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") },
    raw
  );
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });

  let event: ResendEvent;
  try {
    event = JSON.parse(raw) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!event || typeof event.type !== "string") return NextResponse.json({ error: "evento inválido" }, { status: 400 });

  const result = await processResendEvent(req.headers.get("svix-id")!, event);
  return NextResponse.json({ ok: true, ...result });
}
