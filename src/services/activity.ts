import "server-only";
import { getDb, nowIso } from "@/lib/store";
import { uid } from "@/lib/utils";
import type { Activity, ActivityType } from "@/types";

/**
 * Registro da timeline do lead.
 *
 * Vive em módulo próprio (e não em lead-service) porque o motor de
 * automações também precisa registrar atividades — e lead-service emite
 * eventos que chegam ao motor, o que fecharia um ciclo de importação.
 */
export function logActivity(
  leadId: string,
  type: ActivityType,
  description: string,
  userId: string | null
): Activity {
  const db = getDb();
  const activity: Activity = {
    id: uid("act"),
    organization_id: db.organization.id,
    lead_id: leadId,
    type,
    description,
    user_id: userId,
    created_at: nowIso(),
  };
  db.activities.push(activity);
  return activity;
}
