import "server-only";
import { InstagramError, call, instagramConfig, type FetchLike, type InstagramConfig } from "@/services/social/instagram";
import type { PostFormat } from "@/types/agents";

/**
 * PUBLICAR no Instagram. Só o serviço de posts (`services/social/posts.ts`) importa este arquivo, e só
 * pelo clique de "Aprovar e publicar" ou pelo publicador do que você agendou; nenhum agente pode.
 * Um teste confere que o código dos agentes não o cita.
 *
 * Formatos (API Graph de publicação de conteúdo): imagem no Feed; vídeo em Reels (contêiner REELS, com
 * espera do processamento antes de publicar); imagem em Stories (contêiner STORIES, sem legenda).
 */

export interface PublishInput {
  format: PostFormat;
  /** Endereço público (https) da mídia: imagem no Feed e nos Stories, vídeo MP4 nos Reels. */
  mediaUrl: string;
  caption: string;
  /** Identifica o post do nosso lado; a API Graph não tem idempotência própria. */
  idempotencyKey: string;
}

export interface PublishQuota {
  used: number;
  total: number;
}

export interface InstagramPublisher {
  publishMedia(input: PublishInput): Promise<{ id: string; permalink: string | null }>;
  /** Quantas publicações a API ainda aceita nas últimas 24 h; `null` se não deu para ler. */
  quota(): Promise<PublishQuota | null>;
}

export interface PublisherOptions {
  /** Espera entre uma consulta e outra ao processamento do vídeo. */
  pollMs?: number;
  /** Quanto esperar o vídeo ficar pronto antes de desistir (nada foi publicado até aí). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parâmetros do contêiner de mídia de cada formato. */
export function containerParams(input: Pick<PublishInput, "format" | "mediaUrl" | "caption">): Record<string, string> {
  switch (input.format) {
    case "reel":
      return { media_type: "REELS", video_url: input.mediaUrl, caption: input.caption, share_to_feed: "true" };
    case "story":
      // Stories não aceitam legenda pela API: o texto vai na própria arte.
      return { media_type: "STORIES", image_url: input.mediaUrl };
    default:
      return { image_url: input.mediaUrl, caption: input.caption };
  }
}

/** Publicar: criar o contêiner da mídia, esperar (vídeo) e publicá-lo. */
export function createInstagramPublisher(cfg: InstagramConfig | null = instagramConfig(), fetchImpl: FetchLike = fetch, opts: PublisherOptions = {}): InstagramPublisher | null {
  if (!cfg) return null;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 5_000;
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000;

  return {
    async publishMedia(input) {
      const container = await call<{ id: string }>(cfg, fetchImpl, "POST", `${cfg.businessId}/media`, containerParams(input), 60_000);
      if (!container.id) throw new InstagramError("PERMANENT", "O Instagram não devolveu o contêiner da mídia.");

      // Vídeo é processado do lado do Instagram: só se publica quando o contêiner está FINISHED.
      // Nada foi publicado ainda, então falhar aqui NÃO é incerteza (pode tentar de novo).
      if (input.format === "reel") {
        const deadline = Date.now() + maxWaitMs;
        for (;;) {
          const s = await call<{ status_code?: string; status?: string }>(cfg, fetchImpl, "GET", container.id, { fields: "status_code,status" }, 20_000);
          if (s.status_code === "FINISHED") break;
          if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new InstagramError("PERMANENT", `O Instagram não aceitou o vídeo (${s.status_code}${s.status ? `: ${s.status}` : ""}).`);
          if (Date.now() >= deadline) throw new InstagramError("TEMPORARY", "O Instagram não terminou de processar o vídeo a tempo. Tente de novo mais tarde.");
          await sleep(pollMs);
        }
      }

      // A partir daqui a publicação pode sair mesmo que a resposta se perca: TIMEOUT = incerto.
      const published = await call<{ id: string }>(cfg, fetchImpl, "POST", `${cfg.businessId}/media_publish`, { creation_id: container.id }, 60_000);
      let permalink: string | null = null;
      try {
        permalink = (await call<{ permalink?: string }>(cfg, fetchImpl, "GET", published.id, { fields: "permalink" }, 15_000)).permalink ?? null;
      } catch {
        /* o link é só conforto: a publicação já saiu */
      }
      return { id: published.id, permalink };
    },

    async quota() {
      try {
        const j = await call<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(cfg, fetchImpl, "GET", `${cfg.businessId}/content_publishing_limit`, { fields: "quota_usage,config" }, 15_000);
        const row = j.data?.[0];
        if (!row || typeof row.quota_usage !== "number") return null;
        return { used: row.quota_usage, total: row.config?.quota_total ?? 100 };
      } catch {
        return null;
      }
    },
  };
}
