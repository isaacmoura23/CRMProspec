import { NextResponse, type NextRequest } from "next/server";
import { MAX_WEBHOOK_BODY_BYTES, handleGatewayWebhook } from "@/services/whatsapp/webhook";

/**
 * Webhook do gateway de WhatsApp (estado da sessão; depois, mensagens).
 *
 * É público para o proxy (`/api/webhooks` não exige sessão), mas toda
 * requisição precisa de assinatura HMAC válida sobre o corpo bruto, dentro da
 * janela de tolerância. Sem WHATSAPP_WEBHOOK_SECRET recusa tudo: um webhook
 * aberto permitiria forjar "o lead respondeu" ou "o número está conectado".
 *
 * A lógica mora em `services/whatsapp/webhook.ts` (testável sem servidor).
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Antes de ler o corpo: não vale a pena carregar na memória o que será recusado.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BODY_BYTES) return NextResponse.json({ error: "corpo grande demais" }, { status: 413 });

  const rawBody = await req.text();
  const result = await handleGatewayWebhook({ rawBody, headers: req.headers });
  return NextResponse.json(result.body, { status: result.status });
}
