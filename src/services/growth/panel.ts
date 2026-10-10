import "server-only";
import type { SocialConfig, TrafficConfig } from "@/agents/config";
import { calendarSlots, missingSlots, spDay } from "@/agents/social/agent";
import { publicBaseUrl } from "@/lib/creative-policy";
import { agentRepo } from "@/services/agents/repository";
import { getSocialConfig, getTrafficConfig } from "@/services/agents/settings";
import { spendSummary, type SpendSummary } from "@/services/ads/campaigns";
import { findClaude } from "@/services/claude/headless";
import { findFfmpeg } from "@/services/creatives/video";
import { findBrowser } from "@/services/presence/visual";
import { instagramConfig } from "@/services/social/instagram";
import type { AdCampaign, AdReport, Creative, PostFormat, SocialPost, SocialPostStatus } from "@/types/agents";

/** Dados das telas de Mídias Sociais e Gestor de Tráfego, resolvidos no servidor. */

/** O criativo sem o token (o "segredo" do endereço público não vai ao navegador). */
export type CreativeView = Omit<Creative, "token">;
const view = (c: Creative): CreativeView => {
  const rest: Partial<Creative> = { ...c };
  delete rest.token;
  return rest as CreativeView;
};

export interface CalendarItem {
  kind: "post" | "vaga";
  format: PostFormat;
  /** Instante do post (agendado, sugerido ou publicado) ou da vaga livre. */
  at: string | null;
  post_id?: string;
  status?: SocialPostStatus;
  topic?: string;
}

export interface CalendarDay {
  day: string;
  items: CalendarItem[];
}

export interface SocialPanelData {
  config: SocialConfig;
  instagramConfigured: boolean;
  /** Há endereço público (https) para o Instagram buscar a mídia? Sem isto, "Aprovar" fica desligado. */
  hosting: boolean;
  browserFound: boolean;
  ffmpegFound: boolean;
  claudeFound: boolean;
  /** Pendentes e agendados primeiro, depois o histórico recente. */
  posts: SocialPost[];
  /** A arte de cada post, pelo id do criativo. */
  creatives: Record<string, CreativeView>;
  calendar: CalendarDay[];
}

const RANK: Partial<Record<SocialPostStatus, number>> = { pendente: 0, agendado: 1, publicando: 2 };

export async function getSocialPanel(now: Date = new Date()): Promise<SocialPanelData> {
  const [config, posts, creatives] = await Promise.all([
    getSocialConfig(),
    agentRepo().list("social_posts", { orderBy: "created_at", desc: true, limit: 60 }),
    agentRepo().list("creatives", { where: { owner_kind: "post" } }),
  ]);
  const rank = (p: SocialPost) => RANK[p.status] ?? (p.status === "falhou" && p.uncertain ? 2 : 3);
  const sorted = [...posts].sort((a, b) => rank(a) - rank(b) || (a.status === "agendado" && b.status === "agendado" ? (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "") : b.created_at.localeCompare(a.created_at)));

  // Calendário: os próximos dias, com o que já tem post e as vagas que o agente ainda vai propor.
  const days = new Map<string, CalendarItem[]>();
  for (let i = 0; i < config.calendar_days; i++) days.set(spDay(new Date(now.getTime() + i * 86_400_000)), []);
  for (const p of posts) {
    const at = p.scheduled_at ?? p.published_at ?? p.suggested_at;
    if (!at) continue;
    days.get(spDay(new Date(at)))?.push({ kind: "post", format: p.format, at, post_id: p.id, status: p.status, topic: p.topic });
  }
  for (const s of missingSlots(calendarSlots(config, now), posts)) days.get(s.day)?.push({ kind: "vaga", format: s.format, at: s.at });
  const calendar = [...days.entries()].map(([day, items]) => ({ day, items: items.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")) }));

  return {
    config,
    instagramConfigured: Boolean(instagramConfig()),
    hosting: publicBaseUrl() !== null,
    browserFound: Boolean(findBrowser()),
    ffmpegFound: findFfmpeg() !== null,
    claudeFound: findClaude() !== null,
    posts: sorted,
    creatives: Object.fromEntries(creatives.map((c) => [c.id, view(c)])),
    calendar,
  };
}

export interface CampaignRow {
  campaign: AdCampaign;
  last7: { impressions: number; clicks: number; spend_cents: number; conversions: number };
  creative: CreativeView | null;
}

export interface TrafficPanelData {
  config: TrafficConfig;
  summary: SpendSummary;
  rows: CampaignRow[];
  recentReports: AdReport[];
  claudeFound: boolean;
}

export async function getTrafficPanel(now: Date = new Date()): Promise<TrafficPanelData> {
  const [config, summary, campaigns, reports, creatives] = await Promise.all([
    getTrafficConfig(),
    spendSummary(now),
    agentRepo().list("ad_campaigns", { orderBy: "created_at", desc: true, limit: 40 }),
    agentRepo().list("ad_reports", { orderBy: "day", desc: true, limit: 200 }),
    agentRepo().list("creatives", { where: { owner_kind: "campaign" } }),
  ]);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const byId = new Map(creatives.map((c) => [c.id, c]));
  const rank = (c: AdCampaign) => (c.status === "pendente" ? 0 : c.status === "aprovado" || c.status === "ativa" ? 1 : 2);
  const rows = [...campaigns]
    .sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at))
    .map((campaign) => {
      const mine = reports.filter((r) => r.campaign_id === campaign.id && r.day >= since);
      const cr = campaign.creative_id ? byId.get(campaign.creative_id) : undefined;
      return {
        campaign,
        creative: cr ? view(cr) : null,
        last7: {
          impressions: mine.reduce((n, r) => n + r.impressions, 0),
          clicks: mine.reduce((n, r) => n + r.clicks, 0),
          spend_cents: mine.reduce((n, r) => n + r.spend_cents, 0),
          conversions: mine.reduce((n, r) => n + r.conversions, 0),
        },
      };
    });
  return { config, summary, rows, recentReports: reports.slice(0, 10), claudeFound: findClaude() !== null };
}
