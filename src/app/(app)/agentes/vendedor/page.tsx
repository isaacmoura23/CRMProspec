import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth";
import { canAdminister, canWrite } from "@/lib/permissions";
import { AutoRefresh, ModeSelect } from "@/features/agents/controls";
import { MODE_BADGE, MODE_LABEL } from "@/features/agents/labels";
import { EventList, TaskList } from "@/features/agents/task-list";
import { ConversationConfigForm, ConversationsPanel, MeetingsPanel } from "@/features/seller/seller-conversations";
import { OutreachQueue, SellerStats, SentMessages } from "@/features/seller/seller-sections";
import { BlocklistManager, SellerConfigForm } from "@/features/seller/seller-forms";
import { ConnectionPanel } from "@/features/whatsapp/connection-panel";
import { getSellerPanel } from "@/services/outreach/panel";
import { loadWhatsappPanelState } from "@/services/whatsapp/panel";

export const metadata: Metadata = { title: "Vendedor (WhatsApp)" };
export const dynamic = "force-dynamic";

export default async function VendedorPage() {
  const user = await getCurrentUser();
  const canAdmin = canAdminister(user.role);
  const canEdit = canWrite(user.role);
  const [connection, panel] = await Promise.all([loadWhatsappPanelState({ includeQr: canAdmin }), getSellerPanel()]);
  const safeConfig = { ...panel.config, owner_phone: canAdmin ? panel.config.owner_phone : null };

  return (
    <div>
      <AutoRefresh />
      <Link href="/agentes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Agentes
      </Link>
      <PageHeader
        title="Vendedor (WhatsApp)"
        description="Escolhe quem abordar, confirma o WhatsApp do número, escreve a mensagem e a envia dentro da política de envio. Quando o lead responde, trata o pedido, propõe horários, marca a reunião e te avisa; o que não sabe tratar passa para você."
      >
        <Badge variant={MODE_BADGE[panel.mode]}>{MODE_LABEL[panel.mode]}</Badge>
        <ModeSelect agent="seller" mode={panel.mode} canEdit={canAdmin} />
      </PageHeader>

      <div className="space-y-6">
        <ConnectionPanel initial={connection} canConnect={canAdmin} />
        <SellerStats data={panel} />
        <ConversationsPanel attention={panel.attention} recent={panel.conversations} canWrite={canEdit} />
        <MeetingsPanel meetings={panel.meetings} canWrite={canEdit} ownerPhoneSet={panel.ownerPhoneSet} />
        <OutreachQueue rows={panel.queue} canAdmin={canAdmin} />
        <SentMessages rows={panel.messages} canAdmin={canAdmin} />
        {/* O WhatsApp pessoal do dono só vai ao navegador de quem administra. */}
        <SellerConfigForm config={safeConfig} canAdmin={canAdmin} />
        <ConversationConfigForm config={safeConfig} canAdmin={canAdmin} />
        <BlocklistManager rows={panel.blocklist} canAdmin={canAdmin} />

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Preparos de abordagem</CardTitle>
              <CardDescription>Uma tarefa por lead: confirmar o número e escrever a mensagem. Nada é enviado aqui.</CardDescription>
            </CardHeader>
            <TaskList tasks={panel.tasks} canCancel={canAdmin} />
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Registro</CardTitle>
              <CardDescription>O que o Vendedor decidiu e fez.</CardDescription>
            </CardHeader>
            <EventList events={panel.events} />
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Antes de ligar o envio real: o que você precisa saber</CardTitle>
            <CardDescription>A conexão por QR Code não é a API oficial da Meta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-[13px] text-muted-foreground">
            <p>
              O gateway usa a biblioteca Baileys, que fala o protocolo do WhatsApp Web. A Meta não dá suporte a isso e{" "}
              <strong className="text-foreground">pode restringir ou banir o número</strong> que automatiza mensagens, principalmente para quem não é seu contato. Nada neste
              sistema tenta contornar bloqueios.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Use um número <strong className="text-foreground">dedicado</strong>, que você aceite perder. Nunca o seu pessoal.</li>
              <li>
                A ativação é em degraus, e o último é sempre seu: <strong className="text-foreground">simulado</strong> → <strong className="text-foreground">teste restrito</strong> (só o seu
                número recebe) → <strong className="text-foreground">real</strong>. Veja o passo a passo em <code>docs/WHATSAPP_LOCAL.md</code>.
              </li>
              <li>Toda mensagem leva o aviso para parar de receber, e quem pedir entra na lista de bloqueio. O modo de aprovação é o padrão: nada sai sem o seu clique.</li>
              <li>O seu computador precisa ficar ligado e o gateway rodando (<code>npm run gateway</code>) para o número continuar conectado.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
