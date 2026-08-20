import type { Campaign, Database } from "@/types";
import { statusRank } from "@/services/stats";

export interface CampaignStats {
  campaign: Campaign;
  total: number;
  contacted: number;
  replied: number;
  interested: number;
  meetings: number;
  won: number;
  responseRate: number;
  conversionRate: number;
}

export function campaignStats(db: Database, campaign: Campaign): CampaignStats {
  const leads = db.leads.filter((l) => !l.archived && l.campaign_id === campaign.id);
  const contacted = leads.filter((l) => statusRank(l.status) >= 4 || l.status === "perdido").length;
  const replied = leads.filter((l) => statusRank(l.status) >= 5).length;
  const interested = leads.filter((l) => statusRank(l.status) >= 6).length;
  const meetings = leads.filter((l) => statusRank(l.status) >= 7).length;
  const won = leads.filter((l) => l.status === "fechado").length;
  return {
    campaign,
    total: leads.length,
    contacted,
    replied,
    interested,
    meetings,
    won,
    responseRate: contacted > 0 ? Math.round((replied / contacted) * 1000) / 10 : 0,
    conversionRate: leads.length > 0 ? Math.round((won / leads.length) * 1000) / 10 : 0,
  };
}
