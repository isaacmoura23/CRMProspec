import type { Metadata } from "next";
import { getDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { SettingsView } from "@/features/settings/settings-view";

export const metadata: Metadata = { title: "Configurações" };
export const dynamic = "force-dynamic";

export default async function ConfiguracoesPage() {
  const db = getDb();
  const user = await getCurrentUser();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Configurações"
        description="Perfil, organização, regras de prospecção e o contexto que alimenta a IA."
      />
      <SettingsView
        user={user}
        organization={db.organization}
        profile={db.company_profile}
        settings={db.settings}
      />
    </div>
  );
}
