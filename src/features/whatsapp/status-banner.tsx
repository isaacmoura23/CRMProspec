import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getWhatsappLink } from "@/services/whatsapp/link";
import { isWhatsappGatewayConfigured } from "@/services/whatsapp/config";
import { timeAgo } from "@/lib/format";

/**
 * Aviso global de "WhatsApp desconectado".
 *
 * Aparece em todas as páginas, para owner e admin, só quando o recurso está
 * configurado neste ambiente (quem não usa WhatsApp não vê nada) e a conexão
 * não está de pé. É o que impede o número de cair em silêncio: enquanto
 * desconectado, nada é enviado nem marcado como enviado.
 *
 * Lê o estado que o CRM recebeu por webhook, sem ir ao gateway a cada página.
 */
export async function WhatsappStatusBanner() {
  if (!isWhatsappGatewayConfigured()) return null;
  const link = await getWhatsappLink();
  if (link?.status === "CONNECTED") return null;

  const message = !link
    ? "O WhatsApp ainda não foi conectado."
    : link.status === "NEEDS_RECONNECT"
      ? "O WhatsApp foi desconectado e precisa ler o QR Code de novo."
      : link.status === "QR"
        ? "O WhatsApp está esperando a leitura do QR Code."
        : link.status === "CONNECTING"
          ? "O WhatsApp está conectando…"
          : "O WhatsApp está desconectado.";

  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning-soft px-4 py-2.5 text-[13px]">
      <AlertTriangle className="size-4 shrink-0 text-warning" />
      <span className="font-medium">{message}</span>
      {link && <span className="text-muted-foreground">Último estado recebido {timeAgo(link.last_event_at)}. Nenhuma mensagem é enviada enquanto isso.</span>}
      <Link href="/agentes/vendedor" className="ml-auto font-medium text-primary hover:underline">
        Abrir a conexão
      </Link>
    </div>
  );
}
