import "server-only";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isBlockedAddress, validatePublicUrl } from "@/lib/safe-url";

/**
 * Cliente HTTP para conteúdo não confiável (links de currículo, anúncios).
 *
 * Não reaproveita o fetch do enriquecimento comercial porque aqui a URL vem
 * de um PDF enviado pelo usuário: precisa bloquear SSRF. Cada host é
 * resolvido antes da conexão, todos os IPs são conferidos contra faixas
 * reservadas e a conexão é feita no IP validado (o `lookup` fixo fecha a
 * janela de DNS rebinding entre a checagem e o connect). Redirecionamentos
 * são seguidos manualmente, passando pela mesma validação, com limites de
 * bytes durante a leitura, tempo, profundidade e concorrência.
 */

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
}

export interface SafeFetchResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  contentType: string | null;
  body: string;
  truncated: boolean;
  /** Motivo de bloqueio/erro, em linguagem de interface. */
  error: string | null;
  redirects: number;
}

const DEFAULTS = { timeoutMs: 8_000, maxBytes: 1_000_000, maxRedirects: 5 };
const MAX_CONCURRENCY = 3;

const DEFAULT_HEADERS = {
  "User-Agent": "ProspecAtlas-CareerLinkCheck/1 (+https://github.com/isaacmoura23/CRMProspec)",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
};

/* Semáforo simples: no máximo N requisições externas em paralelo por instância. */
let active = 0;
const waiters: Array<() => void> = [];
async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  waiters.shift()?.();
}

async function resolveAddress(hostname: string): Promise<{ address: string; family: 4 | 6 } | string> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return "Host não encontrado (DNS)";
  }
  if (records.length === 0) return "Host sem endereço";
  // Basta um endereço reservado para recusar: o SO pode escolher qualquer um.
  for (const r of records) if (isBlockedAddress(r.address)) return "Host resolve para endereço interno";
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function requestOnce(
  url: URL,
  pinned: { address: string; family: 4 | 6 },
  opts: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxBytes" | "method">> & { headers: Record<string, string> }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: opts.method,
        headers: opts.headers,
        timeout: opts.timeoutMs,
        // Conecta no IP já validado, preservando SNI/Host pelo hostname da URL.
        // Node recente chama o lookup com `all: true` e espera uma lista.
        lookup: (_host, options, cb) => {
          const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
          if (wantsAll) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned.address, family: pinned.family }]);
          else (cb as unknown as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          received += chunk.length;
          if (received > opts.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, opts.maxBytes - (received - chunk.length))));
            res.destroy(); // para de ler: limite de bytes vale durante a leitura, não depois
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8"), truncated })
        );
        res.on("close", () => {
          if (truncated)
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8"), truncated });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo limite excedido")));
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const opts = {
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
    maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
    method: options.method ?? "GET",
    headers: { ...DEFAULT_HEADERS, ...(options.headers ?? {}) },
  };
  const deadline = Date.now() + opts.timeoutMs;
  const fail = (finalUrl: string, error: string, status: number | null = null, redirects = 0): SafeFetchResult => ({
    ok: false, status, finalUrl, contentType: null, body: "", truncated: false, error, redirects,
  });

  let current = rawUrl;
  await acquire();
  try {
    for (let redirects = 0; redirects <= opts.maxRedirects; redirects++) {
      const check = validatePublicUrl(current);
      if (!check.ok) return fail(current, check.reason, null, redirects);
      const url = check.url;

      const pinned = await resolveAddress(url.hostname);
      if (typeof pinned === "string") return fail(current, pinned, null, redirects);

      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail(current, "Tempo limite excedido", null, redirects);

      let res: Awaited<ReturnType<typeof requestOnce>>;
      try {
        res = await requestOnce(url, pinned, { ...opts, timeoutMs: remaining });
      } catch (err) {
        return fail(current, err instanceof Error ? err.message : "Erro de rede", null, redirects);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (!location) return fail(current, "Redirecionamento sem destino", res.status, redirects);
        if (redirects === opts.maxRedirects) return fail(current, "Redirecionamentos em excesso", res.status, redirects);
        current = new URL(location, url).toString();
        continue; // o próximo laço revalida host, IP e esquema do destino
      }

      const contentType = (res.headers["content-type"] as string | undefined) ?? null;
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        finalUrl: url.toString(),
        contentType,
        body: res.body,
        truncated: res.truncated,
        error: res.status >= 400 ? `HTTP ${res.status}` : null,
        redirects,
      };
    }
    return fail(current, "Redirecionamentos em excesso");
  } finally {
    release();
  }
}
