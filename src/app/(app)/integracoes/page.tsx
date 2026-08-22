import type { Metadata } from "next";
import { Bot, Calendar, Database, Mail, MapPin, MessageCircle, Sparkles } from "lucide-react";
import { getDb } from "@/lib/store";
import { isLlmConfigured } from "@/ai/client";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { WebhooksManager } from "@/features/integrations/webhooks-manager";
import { GooglePlacesCard } from "@/features/integrations/google-places-card";
import { isSupabaseConfigured } from "@/lib/auth";
import { timeAgo } from "@/lib/format";

export const metadata: Metadata = { title: "Integrações" };
export const dynamic = "force-dynamic";

const META: Record<string, { icon: React.ComponentType<{ className?: string }>; env: string; description: string }> = {
  OpenAI: { icon: Sparkles, env: "OPENAI_API_KEY", description: "Análises e mensagens geradas pelo modelo da OpenAI (sem chave, o engine interno responde)." },
  "Google Places": { icon: MapPin, env: "GOOGLE_PLACES_API_KEY", description: "Busca empresas reais do Google Maps na prospecção." },
  "WhatsApp Business": { icon: MessageCircle, env: "WHATSAPP_API_TOKEN", description: "Envio e recebimento de mensagens direto no inbox." },
  Gmail: { icon: Mail, env: "GOOGLE_OAUTH_CLIENT_ID", description: "E-mails de prospecção e respostas sincronizados." },
  "Google Calendar": { icon: Calendar, env: "GOOGLE_OAUTH_CLIENT_ID", description: "Reuniões sincronizadas com sua agenda." },
  n8n: { icon: Bot, env: "N8N_WEBHOOK_URL", description: "Automações externas via webhooks bidirecionais." },
  Supabase: { icon: Database, env: "NEXT_PUBLIC_SUPABASE_URL", description: "Banco PostgreSQL gerenciado com RLS multi-tenant (migrations em /database)." },
};

export default function IntegracoesPage() {
  const db = getDb();

  const statusOf = (provider: string): "conectada" | "desconectada" => {
    if (provider === "OpenAI") return isLlmConfigured() ? "conectada" : "desconectada";
    if (provider === "Google Places") return process.env.GOOGLE_PLACES_API_KEY ? "conectada" : "desconectada";
    if (provider === "Supabase") return isSupabaseConfigured() ? "conectada" : "desconectada";
    return "desconectada";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrações"
        description="Conecte fontes de dados, IA e canais. As chaves ficam apenas no servidor (.env) — nunca no navegador."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* O Google Places tem card próprio porque a conexão é verificável
            com uma chamada real, em vez de inferida da variável de ambiente. */}
        <GooglePlacesCard hasKey={Boolean(process.env.GOOGLE_PLACES_API_KEY)} />

        {db.integrations
          .filter((i) => i.provider !== "Google Places")
          .map((integration) => {
          const meta = META[integration.provider];
          const status = statusOf(integration.provider);
          const Icon = meta?.icon ?? Bot;
          return (
            <Card key={integration.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-surface-hover">
                    <Icon className="size-4.5 text-muted-foreground" />
                  </span>
                  <Badge variant={status === "conectada" ? "good" : "neutral"}>
                    {status === "conectada" ? "Conectada" : "Desconectada"}
                  </Badge>
                </div>
                <h3 className="mt-3 text-sm font-semibold">{integration.provider}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {meta?.description}
                </p>
                <p className="mt-3 border-t border-border pt-2.5 text-[11px] text-faint-foreground">
                  {status === "conectada"
                    ? `Última sincronização: ${integration.last_sync_at ? timeAgo(integration.last_sync_at) : "agora"}`
                    : meta
                      ? `Para conectar, defina ${meta.env} no ambiente do servidor.`
                      : ""}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <WebhooksManager webhooks={db.webhooks} />
    </div>
  );
}
