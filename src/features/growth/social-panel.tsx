"use client";

import * as React from "react";
import { ExternalLink, Loader2, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { approveAndPublishPost, editSocialPost, markSocialPostNotPublished, proposePostNow, reconcileSocialPost, rejectSocialPost, reopenSocialPost, saveSocialConfig } from "@/actions/growth";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { SocialConfig } from "@/agents/config";
import type { SocialPost, SocialPostStatus } from "@/types/agents";

const STATUS_LABEL: Record<SocialPostStatus, string> = {
  rascunho: "Rascunho",
  pendente: "Esperando você",
  aprovado: "Aprovado",
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
  publicando: "info",
  publicado: "good",
  falhou: "danger",
  recusado: "outline",
  expirado: "outline",
};

/** O post pendente: legenda e imagem editáveis, e o botão que aprova E publica. */
export function PostCard({ post, canDecide, instagramConfigured }: { post: SocialPost; canDecide: boolean; instagramConfigured: boolean }) {
  const { run, pending } = useAgentAction();
  const [caption, setCaption] = React.useState(post.caption);
  const [image, setImage] = React.useState(post.image_url ?? "");
  const dirty = caption.trim() !== post.caption.trim() || image.trim() !== (post.image_url ?? "");
  const isPending = post.status === "pendente";

  return (
    <li className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{post.topic}</span>
        <Badge variant={STATUS_BADGE[post.status]}>{post.status === "falhou" && post.uncertain ? "Sem confirmação" : STATUS_LABEL[post.status]}</Badge>
        {post.edited && <Badge variant="outline">Editado por você</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(post.created_at)}</span>
      </div>

      {isPending && canDecide ? (
        <div className="space-y-2">
          <Label htmlFor={`cap-${post.id}`}>Legenda</Label>
          <textarea
            id={`cap-${post.id}`}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={7}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
          <p className="text-xs text-muted-foreground">Ideia da imagem: {post.image_idea}</p>
          <Label htmlFor={`img-${post.id}`}>Endereço público da imagem (https)</Label>
          <Input id={`img-${post.id}`} value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…/foto.jpg" />
          <p className="text-xs text-muted-foreground">O Instagram só publica imagem que já esteja num endereço público. Sem ele, o botão de publicar fica desligado.</p>
        </div>
      ) : (
        <blockquote className="whitespace-pre-wrap rounded-lg border-l-2 border-primary bg-surface-hover px-3 py-2 text-[13px]">{post.caption}</blockquote>
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
              <Button
                size="sm"
                className="ml-auto"
                disabled={pending || dirty || !instagramConfigured || !post.image_url}
                title={!instagramConfigured ? "Instagram não configurado" : !post.image_url ? "Falta a imagem" : dirty ? "Salve as alterações primeiro" : undefined}
                onClick={() => run(() => approveAndPublishPost(post.id))}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Send />} Aprovar e publicar
              </Button>
            </>
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

export function SocialPanel({ posts, instagramConfigured, canDecide, canRun }: { posts: SocialPost[]; instagramConfigured: boolean; canDecide: boolean; canRun: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>Posts</CardTitle>
          <CardDescription>
            O agente propõe um por dia. <strong>Nada é publicado sem o seu clique em “Aprovar e publicar”.</strong>{" "}
            {instagramConfigured ? "Instagram configurado." : "Instagram não configurado (veja o passo a passo abaixo): você pode revisar as propostas, mas não publicar."}
          </CardDescription>
        </div>
        {canRun && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => proposePostNow())}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Propor agora
          </Button>
        )}
      </CardHeader>
      {posts.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nenhuma proposta ainda. O agente começa quando estiver ligado e o perfil da empresa tiver serviços ou diferenciais.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} canDecide={canDecide} instagramConfigured={instagramConfigured} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SocialConfigForm({ config, canAdmin }: { config: SocialConfig; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [max, setMax] = React.useState(String(config.max_pending_posts));
  const [ttl, setTtl] = React.useState(String(config.proposal_ttl_days));
  const [tags, setTags] = React.useState(config.hashtags.join(" "));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuração</CardTitle>
        <CardDescription>Hashtags entram no fim de cada legenda proposta (até 8).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Propostas esperando ao mesmo tempo</Label>
            <Input type="number" min={1} max={10} value={max} onChange={(e) => setMax(e.target.value)} disabled={!canAdmin} />
          </div>
          <div className="space-y-1.5">
            <Label>Dias até a proposta expirar</Label>
            <Input type="number" min={1} max={14} value={ttl} onChange={(e) => setTtl(e.target.value)} disabled={!canAdmin} />
          </div>
        </div>
        <div className="max-w-xl space-y-1.5">
          <Label htmlFor="social-tags">Hashtags (separadas por espaço, sem #)</Label>
          <Input id="social-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="estetica curitiba" disabled={!canAdmin} />
        </div>
        {canAdmin && (
          <Button disabled={pending} onClick={() => run(() => saveSocialConfig({ max_pending_posts: Number(max), proposal_ttl_days: Number(ttl), hashtags: tags.split(/\s+/).filter(Boolean) }))}>
            {pending && <Loader2 className="animate-spin" />} Salvar configuração
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
