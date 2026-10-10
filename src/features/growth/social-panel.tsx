"use client";

import * as React from "react";
import { CalendarClock, CalendarX2, ExternalLink, Loader2, Palette, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveAndPublishPost,
  cancelSocialSchedule,
  editSocialPost,
  markSocialPostNotPublished,
  proposePostNow,
  reconcileSocialPost,
  regenerateSocialArt,
  rejectSocialPost,
  reopenSocialPost,
  saveSocialConfig,
  scheduleSocialPost,
} from "@/actions/growth";
import { CreativePreview } from "@/features/growth/creative-preview";
import { useAgentAction } from "@/features/agents/controls";
import { formatBrasilia, formatCalendarDay, toBrasiliaLocal } from "@/lib/brasilia-time";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { SocialConfig } from "@/agents/config";
import type { CalendarDay, CreativeView, SocialPanelData } from "@/services/growth/panel";
import type { PostFormat, SocialPost, SocialPostStatus } from "@/types/agents";

const FORMAT_LABEL: Record<PostFormat, string> = { feed: "Feed", reel: "Reels", story: "Stories" };
const FORMAT_BADGE: Record<PostFormat, "info" | "warning" | "neutral"> = { feed: "info", reel: "warning", story: "neutral" };

const STATUS_LABEL: Record<SocialPostStatus, string> = {
  rascunho: "Rascunho",
  pendente: "Esperando você",
  aprovado: "Aprovado",
  agendado: "Agendado",
  publicando: "Publicando",
  publicado: "Publicado",
  falhou: "Falhou",
  recusado: "Recusado",
  expirado: "Expirou",
};
const STATUS_BADGE: Record<SocialPostStatus, "warning" | "info" | "good" | "danger" | "outline" | "neutral"> = {
  rascunho: "neutral",
  pendente: "warning",
  aprovado: "info",
  agendado: "info",
  publicando: "info",
  publicado: "good",
  falhou: "danger",
  recusado: "outline",
  expirado: "outline",
};

/** O que impede de aprovar este post agora, em português (ou `undefined`). */
function blocker(post: SocialPost, creative: CreativeView | undefined, ctx: { instagramConfigured: boolean; hosting: boolean; dirty: boolean; image: string }): string | undefined {
  if (!ctx.instagramConfigured) return "Instagram não configurado";
  if (ctx.dirty) return "Salve as alterações primeiro";
  const manual = ctx.image.trim().length > 0;
  if (!manual && !creative) return "Falta a arte ou o endereço de uma imagem";
  if (!manual && creative && creative.status !== "pendente" && creative.status !== "aprovado") return creative.status === "falhou" ? "A arte não saiu: peça outro visual" : "A arte não está mais disponível: peça outro visual";
  if (!manual && !ctx.hosting) return "Sem hospedagem pública: defina PUBLIC_BASE_URL (https) ou use um túnel, para o Instagram buscar a mídia";
  return undefined;
}

/** O post: arte, legenda editável e os botões que aprovam — publicar agora ou agendar, um post por clique. */
export function PostCard({ post, creative, canDecide, canRun, instagramConfigured, hosting }: { post: SocialPost; creative?: CreativeView; canDecide: boolean; canRun: boolean; instagramConfigured: boolean; hosting: boolean }) {
  const { run, pending } = useAgentAction();
  const [caption, setCaption] = React.useState(post.caption);
  const [image, setImage] = React.useState(post.image_url ?? "");
  const [when, setWhen] = React.useState(post.suggested_at ? toBrasiliaLocal(post.suggested_at) : "");
  const dirty = caption.trim() !== post.caption.trim() || image.trim() !== (post.image_url ?? "");
  const isPending = post.status === "pendente";
  const why = blocker(post, creative, { instagramConfigured, hosting, dirty, image });

  return (
    <li id={`post-${post.id}`} className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{post.topic}</span>
        <Badge variant={FORMAT_BADGE[post.format]}>{FORMAT_LABEL[post.format]}</Badge>
        <Badge variant={STATUS_BADGE[post.status]}>{post.status === "falhou" && post.uncertain ? "Sem confirmação" : STATUS_LABEL[post.status]}</Badge>
        {post.edited && <Badge variant="outline">Editado por você</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(post.created_at)}</span>
      </div>

      {creative && <CreativePreview creative={creative} />}

      {isPending && canDecide ? (
        <div className="space-y-2">
          <Label htmlFor={`cap-${post.id}`}>Legenda{post.format === "story" ? " (Stories não levam legenda pela API: o texto está na arte)" : ""}</Label>
          <textarea
            id={`cap-${post.id}`}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Usar uma imagem minha em vez da arte</summary>
            <div className="space-y-1.5 pt-1.5">
              <Label htmlFor={`img-${post.id}`}>Endereço público da imagem ou vídeo (https)</Label>
              <Input id={`img-${post.id}`} value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…/foto.jpg" />
              <p>Vale no lugar da arte. O Instagram só publica mídia que já esteja num endereço público.</p>
            </div>
          </details>
          <div className="space-y-1">
            <Label htmlFor={`when-${post.id}`}>Agendar para (horário de Brasília)</Label>
            <Input id={`when-${post.id}`} type="datetime-local" className="w-56" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
        </div>
      ) : (
        <blockquote className="whitespace-pre-wrap rounded-lg border-l-2 border-primary bg-surface-hover px-3 py-2 text-[13px]">{post.caption}</blockquote>
      )}

      {post.status === "agendado" && post.scheduled_at && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarClock className="size-3.5" /> Sai em <strong className="text-foreground">{formatBrasilia(post.scheduled_at)}</strong> (Brasília), depois de o sistema reconferir legenda, arte e data aprovadas.
        </p>
      )}
      {post.error && <p className={`text-xs ${post.uncertain ? "text-warning" : "text-danger"}`}>{post.error}</p>}
      {post.status === "publicado" && (
        <p className="text-xs text-muted-foreground">
          Publicado {timeAgo(post.published_at)}.{" "}
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Ver no Instagram <ExternalLink className="size-3.5" />
            </a>
          )}
        </p>
      )}
      {isPending && <p className="text-xs text-faint-foreground">Expira em {formatDateTime(post.expires_at)}.</p>}

      {canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          {isPending && (
            <>
              {dirty && (
                <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => editSocialPost(post.id, { caption, image_url: image.trim() || null }))}>
                  Salvar alterações
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => rejectSocialPost(post.id))}>
                <X /> Recusar
              </Button>
              {canRun && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => regenerateSocialArt(post.id))}>
                  <Palette /> Outro visual
                </Button>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" disabled={pending || Boolean(why) || !when} title={why ?? (!when ? "Escolha a data e a hora" : undefined)} onClick={() => run(() => scheduleSocialPost(post.id, when))}>
                  {pending ? <Loader2 className="animate-spin" /> : <CalendarClock />} Aprovar e agendar
                </Button>
                <Button size="sm" disabled={pending || Boolean(why)} title={why} onClick={() => run(() => approveAndPublishPost(post.id))}>
                  {pending ? <Loader2 className="animate-spin" /> : <Send />} Aprovar e publicar
                </Button>
              </div>
              {why && <p className="w-full text-xs text-warning">{why}.</p>}
            </>
          )}
          {post.status === "agendado" && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => cancelSocialSchedule(post.id))}>
              <CalendarX2 /> Cancelar agendamento
            </Button>
          )}
          {post.status === "falhou" && !post.uncertain && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => reopenSocialPost(post.id))}>
              <RefreshCw /> Reabrir para tentar de novo
            </Button>
          )}
          {post.status === "falhou" && post.uncertain && (
            <>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => reconcileSocialPost(post.id))}>
                Conferir no Instagram
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => markSocialPostNotPublished(post.id))}>
                Conferi: não saiu
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Os próximos dias: o que já tem post (e em que estado) e as vagas que o agente ainda vai propor. */
export function CalendarCard({ calendar }: { calendar: CalendarDay[] }) {
  const total = calendar.reduce((n, d) => n + d.items.filter((i) => i.kind === "post").length, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendário editorial</CardTitle>
        <CardDescription>
          Os próximos dias, no horário de Brasília. Cada post pede o seu clique: <strong>“Aprovar e publicar”</strong> sai agora, <strong>“Aprovar e agendar”</strong> sai na hora marcada, e nada é aprovado em lote.
          {total === 0 ? " Ainda não há posts neste período." : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {calendar.map((d) => (
            <li key={d.day} className="rounded-lg border border-border p-2.5">
              <p className="mb-1.5 text-xs font-semibold capitalize text-muted-foreground">{formatCalendarDay(d.day)}</p>
              {d.items.length === 0 ? (
                <p className="text-xs text-faint-foreground">Sem posts previstos.</p>
              ) : (
                <ul className="space-y-1">
                  {d.items.map((i, k) =>
                    i.kind === "post" ? (
                      <li key={i.post_id ?? k}>
                        <a href={`#post-${i.post_id}`} className="flex flex-wrap items-center gap-1 rounded-md px-1 py-0.5 text-xs hover:bg-surface-hover">
                          <Badge variant={FORMAT_BADGE[i.format]}>{FORMAT_LABEL[i.format]}</Badge>
                          <span className="text-muted-foreground">{i.at ? formatBrasilia(i.at).slice(-5) : ""}</span>
                          <Badge variant={STATUS_BADGE[i.status!]}>{STATUS_LABEL[i.status!]}</Badge>
                        </a>
                      </li>
                    ) : (
                      <li key={`vaga-${k}`} className="flex items-center gap-1 rounded-md border border-dashed border-border px-1 py-0.5 text-xs text-muted-foreground">
                        <Badge variant="outline">{FORMAT_LABEL[i.format]}</Badge> {i.at ? formatBrasilia(i.at).slice(-5) : ""} vaga a propor
                      </li>
                    )
                  )}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function SocialPanel({ data, canDecide, canRun }: { data: SocialPanelData; canDecide: boolean; canRun: boolean }) {
  const { run, pending } = useAgentAction();
  const notes: string[] = [];
  if (!data.browserFound) notes.push("Chrome/Edge não encontrados: sem eles não há como gerar as artes.");
  if (!data.ffmpegFound) notes.push("ffmpeg não encontrado: Reels (vídeo) ficam sem arte. Instale o ffmpeg ou use FFMPEG_PATH.");
  if (!data.hosting) notes.push("Sem hospedagem pública: defina PUBLIC_BASE_URL (https) ou use um túnel. Você pode revisar e aprovar a arte, mas o Instagram não consegue buscá-la.");
  return (
    <div className="space-y-6">
      <CalendarCard calendar={data.calendar} />
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Posts</CardTitle>
            <CardDescription>
              O agente propõe os posts do calendário, com a arte pronta. <strong>Nada é publicado sem o seu clique.</strong>{" "}
              {data.instagramConfigured ? "Instagram configurado." : "Instagram não configurado (veja o passo a passo abaixo): você pode revisar as propostas, mas não publicar."}
            </CardDescription>
            {notes.map((n) => (
              <p key={n} className="text-xs text-warning">
                {n}
              </p>
            ))}
          </div>
          {canRun && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => proposePostNow())}>
              {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Propor agora
            </Button>
          )}
        </CardHeader>
        {data.posts.length === 0 ? (
          <CardContent>
            <p className="text-[13px] text-muted-foreground">Nenhuma proposta ainda. O agente começa quando estiver ligado e o perfil da empresa tiver serviços ou diferenciais.</p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {data.posts.map((p) => (
              <PostCard key={p.id} post={p} creative={p.creative_id ? data.creatives[p.creative_id] : undefined} canDecide={canDecide} canRun={canRun} instagramConfigured={data.instagramConfigured} hosting={data.hosting} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function SocialConfigForm({ config, claudeFound, canAdmin }: { config: SocialConfig; claudeFound: boolean; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [n, setN] = React.useState({
    max: String(config.max_pending_posts),
    ttl: String(config.proposal_ttl_days),
    days: String(config.calendar_days),
    feed: String(config.weekly_feed),
    reel: String(config.weekly_reel),
    story: String(config.weekly_story),
    feedH: String(config.feed_hour),
    reelH: String(config.reel_hour),
    storyH: String(config.story_hour),
    late: String(config.late_window_hours),
    budget: String(config.creative_budget_usd),
  });
  const [tags, setTags] = React.useState(config.hashtags.join(" "));
  const [builder, setBuilder] = React.useState<SocialConfig["creative_builder"]>(config.creative_builder);
  const set = (k: keyof typeof n) => (v: string) => setN((s) => ({ ...s, [k]: v }));
  const field = (label: string, k: keyof typeof n, min: number, max: number, hint?: string, step?: number) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} step={step} value={n[k]} onChange={(e) => set(k)(e.target.value)} disabled={!canAdmin} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração</CardTitle>
        <CardDescription>Calendário, horários (Brasília), artes e hashtags (entram no fim de cada legenda, até 8).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
          {field("Dias planejados à frente", "days", 1, 14)}
          {field("Posts de Feed por semana", "feed", 0, 7)}
          {field("Reels por semana", "reel", 0, 7)}
          {field("Stories por semana", "story", 0, 14)}
          {field("Hora do Feed", "feedH", 0, 23)}
          {field("Hora dos Reels", "reelH", 0, 23)}
          {field("Hora dos Stories", "storyH", 0, 23)}
          {field("Propostas esperando ao mesmo tempo", "max", 1, 20)}
          {field("Dias até a proposta expirar", "ttl", 1, 14)}
          {field("Tolerância de atraso (h)", "late", 1, 24, "Passada a janela, o post agendado não sai fora de hora: o sistema avisa.")}
        </div>
        <div className="max-w-xl space-y-1.5">
          <Label htmlFor="social-tags">Hashtags (separadas por espaço, sem #)</Label>
          <Input id="social-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="estetica curitiba" disabled={!canAdmin} />
        </div>
        <fieldset className="max-w-xl space-y-3 rounded-lg border border-border p-4" disabled={!canAdmin}>
          <legend className="px-1 text-[13px] font-medium">Quem escreve a arte (imagens)</legend>
          {(
            [
              ["modelos", "Modelos de arte", "Em código, sem custo. Três composições; “Outro visual” troca."],
              ["claude-code", "Claude Code", "Escreve o HTML da arte em modo restrito (só arquivos). A mesma verificação vale; se falhar ou estourar o teto, sai o modelo."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex cursor-pointer items-start gap-2.5">
              <input type="radio" name="creative-builder" className="mt-0.5 size-4 accent-[var(--color-primary)]" checked={builder === value} onChange={() => setBuilder(value)} />
              <span>
                <span className="block text-[13px] font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{claudeFound ? "Claude Code encontrado nesta máquina." : "Claude Code não encontrado: com ele escolhido, saem os modelos de arte."} Vídeos (Reels) sempre usam os modelos de cena e o ffmpeg.</p>
          {builder === "claude-code" && field("Teto por arte (US$)", "budget", 0.1, 5, undefined, 0.1)}
        </fieldset>
        {canAdmin && (
          <Button
            disabled={pending}
            onClick={() =>
              run(() =>
                saveSocialConfig({
                  max_pending_posts: Number(n.max),
                  proposal_ttl_days: Number(n.ttl),
                  hashtags: tags.split(/\s+/).filter(Boolean),
                  calendar_days: Number(n.days),
                  weekly_feed: Number(n.feed),
                  weekly_reel: Number(n.reel),
                  weekly_story: Number(n.story),
                  feed_hour: Number(n.feedH),
                  reel_hour: Number(n.reelH),
                  story_hour: Number(n.storyH),
                  late_window_hours: Number(n.late),
                  creative_builder: builder,
                  creative_budget_usd: Number(n.budget),
                })
              )
            }
          >
            {pending && <Loader2 className="animate-spin" />} Salvar configuração
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
