import "server-only";
import fs from "node:fs";
import { Readable } from "node:stream";
import type { CreativeFileRef } from "@/services/creatives/engine";

/** Intervalo pedido (`Range: bytes=a-b`), limitado ao tamanho do arquivo; `null` = o arquivo todo; `"invalido"` = 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalido" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalido";
  let start: number;
  let end: number;
  if (m[1] === "") {
    // "-N": os últimos N bytes
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalido";
  return { start, end };
}

/** Responde com o arquivo (com suporte a `Range`, que o Instagram e os players usam para vídeo). */
export function serveFile(ref: CreativeFileRef, rangeHeader: string | null, headers: Record<string, string>): Response {
  const range = parseRange(rangeHeader, ref.size);
  const common = { ...headers, "Content-Type": ref.type, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
  if (range === "invalido") return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${ref.size}` } });
  const part = range ?? { start: 0, end: ref.size - 1 };
  const stream = Readable.toWeb(fs.createReadStream(ref.path, { start: part.start, end: part.end })) as unknown as ReadableStream;
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: { ...common, "Content-Length": String(part.end - part.start + 1), ...(range ? { "Content-Range": `bytes ${part.start}-${part.end}/${ref.size}` } : {}) },
  });
}
