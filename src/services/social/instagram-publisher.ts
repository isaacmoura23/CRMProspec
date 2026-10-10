import "server-only";
import { InstagramError, call, instagramConfig, type FetchLike, type InstagramConfig } from "@/services/social/instagram";

/**
 * PUBLICAR no Instagram. Só a ação do botão "Aprovar e publicar" (via `services/social/posts.ts`)
 * importa este arquivo; nenhum agente pode. Um teste confere que o código dos agentes não o cita.
 */

export interface PublishInput {
  imageUrl: string;
  caption: string;
  /** Identifica o post do nosso lado; a API Graph não tem idempotência própria. */
  idempotencyKey: string;
}

export interface InstagramPublisher {
  publishImage(input: PublishInput): Promise<{ id: string; permalink: string | null }>;
}

/** Publicar: dois passos da API Graph (criar o contêiner da mídia e publicá-lo). */
export function createInstagramPublisher(cfg: InstagramConfig | null = instagramConfig(), fetchImpl: FetchLike = fetch): InstagramPublisher | null {
  if (!cfg) return null;
  return {
    async publishImage({ imageUrl, caption }) {
      const container = await call<{ id: string }>(cfg, fetchImpl, "POST", `${cfg.businessId}/media`, { image_url: imageUrl, caption }, 60_000);
      if (!container.id) throw new InstagramError("PERMANENT", "O Instagram não devolveu o contêiner da mídia.");
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
  };
}
