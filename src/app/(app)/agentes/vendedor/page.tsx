import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth";
import { canAdminister } from "@/lib/permissions";
import { ConnectionPanel } from "@/features/whatsapp/connection-panel";
import { loadWhatsappPanelState } from "@/services/whatsapp/panel";

export const metadata: Metadata = { title: "Vendedor (WhatsApp)" };
export const dynamic = "force-dynamic";

export default async function VendedorPage() {
  const user = await getCurrentUser();
  const canConnect = canAdminister(user.role);
  const initial = await loadWhatsappPanelState({ includeQr: canConnect });

  return (
    <div>
      <Link href="/agentes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Agentes
      </Link>
      <PageHeader
        title="Vendedor (WhatsApp)"
        description="Conexão do número dedicado à prospecção. O Vendedor Sênior em si (mensagens, conversa e reuniões) chega nas próximas fases."
      />
      <div className="space-y-6">
        <ConnectionPanel initial={initial} canConnect={canConnect} />

        <Card>
          <CardHeader>
            <CardTitle>Antes de conectar: o que você precisa saber</CardTitle>
            <CardDescription>A conexão por QR Code não é a API oficial da Meta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-[13px] text-muted-foreground">
            <p>
              O gateway usa a biblioteca Baileys, que fala o protocolo do WhatsApp Web. A Meta não dá suporte a isso e <strong className="text-foreground">pode restringir ou
              banir o número</strong> que automatiza mensagens, principalmente para quem não é seu contato. Nada neste sistema tenta contornar bloqueios.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Use um número <strong className="text-foreground">dedicado</strong>, que você aceite perder. Nunca o seu pessoal.</li>
              <li>O gateway nasce em <strong className="text-foreground">modo de teste</strong>: conecta e consulta, mas não envia nada.</li>
              <li>O seu computador precisa ficar ligado e o gateway rodando (`npm run gateway`) para o número continuar conectado.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
