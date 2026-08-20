import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { PageHeader } from "@/components/page-header";
import { TeamView } from "@/features/team/team-view";

export const metadata: Metadata = { title: "Equipe" };
export const dynamic = "force-dynamic";

export default function EquipePage() {
  const db = getDb();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Equipe"
        description="Membros da organização e seus papéis (Owner, Admin, SDR, Vendedor, Viewer)."
      />
      <TeamView members={db.users} />
    </div>
  );
}
