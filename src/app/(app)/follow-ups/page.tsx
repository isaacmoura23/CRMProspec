import type { Metadata } from "next";
import { Repeat } from "lucide-react";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { FollowUpsView, type FollowUpItem } from "@/features/followups/followups-view";

export const metadata: Metadata = { title: "Follow-ups" };
export const dynamic = "force-dynamic";

export default function FollowUpsPage() {
  const db = getDb();

  const items: FollowUpItem[] = db.tasks
    .filter((t) => t.type === "follow_up" && t.lead_id)
    .map((t) => {
      const lead = db.leads.find((l) => l.id === t.lead_id);
      const conv = db.conversations.find((c) => c.lead_id === t.lead_id);
      const lastInbound = conv
        ? [...db.messages]
            .filter((m) => m.conversation_id === conv.id && m.direction === "in")
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
        : undefined;
      return {
        ...t,
        lead_name: lead?.company_name ?? "Lead removido",
        lead_score: lead?.lead_score ?? null,
        last_inbound: lastInbound?.content ?? null,
        last_inbound_at: lastInbound?.created_at ?? null,
        last_classification: lastInbound?.classification ?? null,
      };
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Follow-ups"
        description="Retomadas de contato com contexto da última interação e sugestão da IA."
      />
      {items.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="Nenhum follow-up agendado"
          description="Crie tarefas de follow-up nos leads para não deixar oportunidades esfriarem."
        />
      ) : (
        <FollowUpsView items={items} />
      )}
    </div>
  );
}
