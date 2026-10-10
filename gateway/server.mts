import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GatewayError, type SessionManager } from "./session.mjs";
import type { GatewayStore } from "./store.mjs";

/**
 * API HTTP do gateway. Só o CRM a usa, sempre com o token no cabeçalho
 * `Authorization: Bearer`. Rotas, formatos e códigos de erro seguem os da Cobra,
 * para o cliente do CRM (`providers/whatsapp/qr-gateway.ts`) entender os mesmos
 * `kind`.
 *
 *   GET  /health                          sem autenticação, sem dados sensíveis
 *   GET  /sessions/:id/status             estado, número e QR
 *   POST /sessions/:id/connect            abre a sessão e devolve o QR
 *   POST /sessions/:id/disconnect         fecha o socket, guarda a sessão
 *   POST /sessions/:id/logout             encerra e apaga a sessão
 *   POST /sessions/:id/recipient          { to } → o número tem WhatsApp?
 *   POST /sessions/:id/messages           { to, text, clientReference, authorization? }
 *                                         simulado, ou real com a autorização de envio do CRM
 */

const MAX_BODY_BYTES = 64 * 1024;
const ROUTE = /^\/sessions\/([A-Za-z0-9_-]{1,64})\/(status|connect|disconnect|logout|messages|recipient)$/;

function tokenMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new GatewayError(413, "PERMANENT", "corpo grande demais");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, "PERMANENT", "JSON inválido");
  }
}

export function createGatewayServer(deps: {
  manager: SessionManager;
  store: GatewayStore;
  token: string;
  dryRun: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): http.Server {
  const { manager, store, token } = deps;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://gateway");

      if (url.pathname === "/health" && req.method === "GET") {
        return send(res, 200, { ok: true, dryRun: deps.dryRun, sessions: manager.sessionSummaries(), outbox: store.outboxCounts() });
      }

      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !tokenMatches(auth.slice(7), token)) {
        return send(res, 401, { error: "não autorizado", kind: "AUTH" });
      }

      const match = ROUTE.exec(url.pathname);
      if (!match) return send(res, 404, { error: "rota inexistente" });
      const [, sessionId, action] = match as unknown as [string, string, string];

      if (action === "status" && req.method === "GET") return send(res, 200, { ...manager.status(sessionId) });
      if (action === "connect" && req.method === "POST") return send(res, 200, { ...(await manager.connect(sessionId)) });
      if ((action === "disconnect" || action === "logout") && req.method === "POST") {
        return send(res, 200, { ...(await manager.disconnect(sessionId, action === "logout")) });
      }
      if (action === "recipient" && req.method === "POST") {
        const body = await readJson(req);
        return send(res, 200, { ...(await manager.recipient(sessionId, String(body.to ?? ""))) });
      }
      if (action === "messages" && req.method === "POST") {
        const body = await readJson(req);
        const result = await manager.send(sessionId, {
          to: String(body.to ?? ""),
          text: String(body.text ?? ""),
          clientReference: typeof body.clientReference === "string" ? body.clientReference : "",
          authorization: body.authorization && typeof body.authorization === "object" ? (body.authorization as { expires_at?: number; signature?: string }) : null,
        });
        return send(res, 200, { ...result, documentMessageId: null });
      }
      return send(res, 405, { error: "método não permitido" });
    } catch (err) {
      if (err instanceof GatewayError) return send(res, err.httpStatus, { error: err.message, kind: err.kind });
      deps.log?.("erro na requisição", { error: err instanceof Error ? err.message : String(err) });
      return send(res, 500, { error: "erro interno", kind: "TEMPORARY" });
    }
  });
}
