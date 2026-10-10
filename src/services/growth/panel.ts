import "server-only";
import type { SocialConfig, TrafficConfig } from "@/agents/config";
import { agentRepo } from "@/services/agents/repository";
import { getSocialConfig, getTrafficConfig } from "@/services/agents/settings";
import { spendSummary, type SpendSummary } from "@/services/ads/campaigns";
import { instagramConfig } from "@/services/social/instagram";
import type { AdCampaign, AdReport, SocialPost } from "@/types/agents";

/** Dados das telas de Mídias Sociais e Gestor de Tráfego, resolvidos no servidor. */

export interface SocialPanelData {
  config: SocialConfig;
  instagramConfigured: boolean;
  /** Pendentes primeiro, depois o histórico recente. */
  posts: SocialPost[];
}

export async function getSocialPanel(): Promise<SocialPanelData> {
  const [config, posts] = await Promise.all([getSocialConfig(), agentRepo().list("social_posts", { orderBy: "created_at", desc: true, limit: 40 })]);
  const rank = (p: SocialPost) => (p.status === "pendente" ? 0 : p.status === "publicando" || (p.status === "falhou" && p.uncertain) ? 1 : 2);
  return { config, instagramConfigured: Boolean(instagramConfig()), posts: [...posts].sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at)) };
}

export interface CampaignRow {
  campaign: AdCampaign;
  last7: { impressions: number; clicks: number; spend_cents: number; conversions: number };
}

export interface TrafficPanelData {
  config: TrafficConfig;
  summary: SpendSummary;
  rows: CampaignRow[];
  recentReports: AdReport[];
}

export async function getTrafficPanel(now: Date = new Date()): Promise<TrafficPanelData> {
  const [config, summary, campaigns, reports] = await Promise.all([
    getTrafficConfig(),
    spendSummary(now),
    agentRepo().list("ad_campaigns", { orderBy: "created_at", desc: true, limit: 40 }),
    agentRepo().list("ad_reports", { orderBy: "day", desc: true, limit: 200 }),
  ]);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const rank = (c: AdCampaign) => (c.status === "pendente" ? 0 : c.status === "aprovado" || c.status === "ativa" ? 1 : 2);
  const rows = [...campaigns]
    .sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at))
    .map((campaign) => {
      const mine = reports.filter((r) => r.campaign_id === campaign.id && r.day >= since);
      return {
        campaign,
        last7: {
          impressions: mine.reduce((n, r) => n + r.impressions, 0),
          clicks: mine.reduce((n, r) => n + r.clicks, 0),
          spend_cents: mine.reduce((n, r) => n + r.spend_cents, 0),
          conversions: mine.reduce((n, r) => n + r.conversions, 0),
        },
      };
    });
  return { config, summary, rows, recentReports: reports.slice(0, 10) };
}
