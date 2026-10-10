import "server-only";

/**
 * Cliente da API Graph do Instagram (conta Business ligada a uma página do Facebook).
 *
 * Este arquivo só LÊ (perfil e posts): é o único que os agentes podem importar. Publicar
 * mora em `instagram-publisher.ts`, importado só pelo serviço que a Server Action do botão
 * "Aprovar e publicar" chama — a fronteira é física, não só combinada.
 * Nada aqui é MCP: é HTTP direto, com o token vindo do ambiente (nunca do chat).
 */

export type InstagramErrorKind = "AUTH" | "RATE_LIMITED" | "TEMPORARY" | "PERMANENT" | "TIMEOUT";

export class InstagramError extends Error {
  constructor(
    public readonly kind: InstagramErrorKind,
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = "InstagramError";
  }
  /** Sem confirmação: a publicação pode ter saído. Nunca repetir sozinho. */
  get uncertain(): boolean {
    return this.kind === "TIMEOUT";
  }
}

export interface InstagramConfig {
  token: string;
  businessId: string;
  version: string;
}

export function instagramConfig(env: Record<string, string | undefined> = process.env): InstagramConfig | null {
  const token = env.INSTAGRAM_ACCESS_TOKEN?.trim();
  const businessId = env.INSTAGRAM_BUSINESS_ID?.trim();
  if (!token || !businessId || !/^\d{5,30}$/.test(businessId)) return null;
  return { token, businessId, version: env.META_GRAPH_VERSION?.trim() || "v21.0" };
}

export interface SocialProfile {
  username: string;
  name: string | null;
  followers: number | null;
  mediaCount: number | null;
  biography: string | null;
}

export interface SocialMedia {
  id: string;
  caption: string;
  mediaType: string;
  permalink: string | null;
  timestamp: string | null;
  likes: number | null;
  comments: number | null;
}

/** Só leitura: é tudo o que um agente recebe. */
export interface InstagramReader {
  profile(): Promise<SocialProfile>;
  recentMedia(limit?: number): Promise<SocialMedia[]>;
}

export type FetchLike = typeof fetch;

function classify(status: number, body: { error?: { message?: string; code?: number } } | null): InstagramError {
  const message = body?.error?.message ?? `HTTP ${status}`;
  const code = body?.error?.code;
  if (status === 401 || status === 403 || code === 190 || code === 10 || code === 200) return new InstagramError("AUTH", message, code);
  if (status === 429 || code === 4 || code === 17 || code === 32 || code === 613) return new InstagramError("RATE_LIMITED", message, code);
  if (status >= 500 || code === 1 || code === 2) return new InstagramError("TEMPORARY", message, code);
  return new InstagramError("PERMANENT", message, code);
}

export async function call<T>(cfg: InstagramConfig, fetchImpl: FetchLike, method: "GET" | "POST", path: string, params: Record<string, string>, timeoutMs: number): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${cfg.version}/${path}`);
  let body: URLSearchParams | undefined;
  if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else body = new URLSearchParams(params);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      // O token vai no cabeçalho, não na URL: URLs acabam em log.
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new InstagramError(timedOut ? "TIMEOUT" : "TEMPORARY", timedOut ? "Sem resposta do Instagram" : "Falha de rede ao falar com o Instagram");
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: number } }) | null;
  if (!res.ok || json?.error) throw classify(res.status, json);
  return json as T;
}

export function createInstagramReader(cfg: InstagramConfig | null = instagramConfig(), fetchImpl: FetchLike = fetch): InstagramReader | null {
  if (!cfg) return null;
  return {
    async profile() {
      const j = await call<{ username?: string; name?: string; followers_count?: number; media_count?: number; biography?: string }>(
        cfg, fetchImpl, "GET", cfg.businessId, { fields: "username,name,followers_count,media_count,biography" }, 15_000
      );
      return { username: j.username ?? "", name: j.name ?? null, followers: j.followers_count ?? null, mediaCount: j.media_count ?? null, biography: j.biography ?? null };
    },
    async recentMedia(limit = 12) {
      const j = await call<{ data?: Array<{ id: string; caption?: string; media_type?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number }> }>(
        cfg, fetchImpl, "GET", `${cfg.businessId}/media`, { fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count", limit: String(Math.min(50, Math.max(1, limit))) }, 15_000
      );
      return (j.data ?? []).map((m) => ({ id: m.id, caption: m.caption ?? "", mediaType: m.media_type ?? "IMAGE", permalink: m.permalink ?? null, timestamp: m.timestamp ?? null, likes: m.like_count ?? null, comments: m.comments_count ?? null }));
    },
  };
}

