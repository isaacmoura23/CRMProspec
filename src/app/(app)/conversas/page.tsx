import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Inbox } from "@/features/conversations/inbox";

export const metadata: Metadata = { title: "Conversas" };
export const dynamic = "force-dynamic";

export default function ConversasPage() {
  const db = getDb();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Conversas"
        description="Inbox unificado — WhatsApp e e-mail em um só lugar (canais reais conectáveis em Integrações)."
      />
      {db.conversations.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="Nenhuma conversa ainda"
          description="Quando você fizer contato com leads, as conversas aparecem aqui com contexto e classificação automática."
        >
          <Button asChild>
            <Link href="/leads">Ver leads</Link>
          </Button>
        </EmptyState>
      ) : (
        <Inbox
          data={{
            conversations: db.conversations,
            messages: db.messages,
            leads: db.leads,
            users: db.users,
            stages: db.pipeline_stages,
          }}
        />
      )}
    </div>
  );
}
