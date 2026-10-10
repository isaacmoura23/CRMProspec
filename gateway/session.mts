import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { DisconnectReason, type AuthenticationState } from "@whiskeysockets/baileys";
import { motivoDeStatus } from "../src/lib/whatsapp-status";
import { isE164, recipientJid } from "../src/lib/whatsapp-send-policy";
import type { GatewayEvent } from "../src/lib/gateway-events";
import { sqliteAuthState } from "./auth-state.mjs";
import type { GatewayStore, SessionStatus } from "./store.mjs";

/**
 * Gerenciador de sessões do WhatsApp (dispositivo vinculado, por QR Code).
 *
 * Portado do gateway da Cobra (agenteitalo/gateway/index.mts), com três
 * mudanças: o Baileys entra por uma fábrica injetável (dá para testar o ciclo
 * inteiro sem WhatsApp), o estado vai para a caixa de saída em vez de ser
 * gravado direto no banco do app, e não há varredura de lembretes nem criação
 * de clientes — o gateway só conecta, reporta e (quando liberado) envia.
 *
 * NÃO é a API oficial da Meta: usa o protocolo do WhatsApp Web, o número pode
 * ser restringido ou banido por automação, e nada aqui tenta contornar isso.
 */

/** O mínimo do socket do Baileys que o gerenciador usa — o que permite um falso nos testes. */
export interface WaSocketLike {
  ev: { on(event: string, handler: (...args: any[]) => void): void }; // eslint-disable-line @typescript-eslint/no-explicit-any
  user?: { id: string; name?: string } | null;
  end(error?: Error): void | Promise<void>;
  logout(): Promise<void>;
  onWhatsApp(...phoneNumbers: string[]): Promise<Array<{ exists: boolean; jid: string }> | undefined>;
}

export type SocketFactory = (args: { sessionId: string; state: AuthenticationState }) => Promise<WaSocketLike>;

export type EmittedEvent = GatewayEvent;

export interface PublicStatus {
  status: SessionStatus;
  phone: string | null;
  pushName: string | null;
  qrDataUrl: string | null;
  qrUpdatedAt: string | null;
  lastError: string | null;
  dryRun: boolean;
}

/** Erro com o código HTTP e o tipo que o CRM entende (`kind`, como em ProviderError). */
export class GatewayError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly kind: "DISCONNECTED" | "INVALID_RECIPIENT" | "TEMPORARY" | "PERMANENT",
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface SessionManagerDeps {
  store: GatewayStore;
  factory: SocketFactory;
  /** Chamado para cada evento a entregar ao CRM. */
  emit: (event: EmittedEvent) => void;
  dryRun: boolean;
  forwardMessages: boolean;
  qrWaitMaxMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Live {
  sessionId: string;
  sock: WaSocketLike | null;
  status: SessionStatus;
  qrDataUrl: string | null;
  qrUpdatedAt: Date | null;
  qrStartedAt: Date | null;
  phone: string | null;
  pushName: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  stopping: boolean;
  clear: (() => void) | null;
  lastEmitted: string | null;
}

export function jidToE164(jid: string): string {
  return `+${jid.split("@")[0]!.split(":")[0]!.replace(/\D/g, "")}`;
}

/** Telefone de uma conversa individual (aceita `@lid` com o telefone em remoteJidAlt). */
function individualPeer(m: { key: { remoteJid?: string | null; remoteJidAlt?: string | null } }): string | null {
  const jid = m.key.remoteJid ?? "";
  if (jid.endsWith("@s.whatsapp.net")) return jidToE164(jid);
  const alt = m.key.remoteJidAlt ?? "";
  return alt.endsWith("@s.whatsapp.net") ? jidToE164(alt) : null;
}

type RawMessage = {
  key: { id?: string | null; remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
  message?: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  pushName?: string | null;
};

function contentOf(m: RawMessage): { text: string; mediaType: string | null } | null {
  const msg = m.message;
  if (!msg) return null;
  const caption = msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? msg.documentMessage?.caption ?? null;
  const text: string = msg.conversation ?? msg.extendedTextMessage?.text ?? caption ?? "";
  const mediaType = msg.imageMessage
    ? "imagem"
    : msg.videoMessage
      ? "vídeo"
      : msg.audioMessage
        ? "áudio"
        : msg.documentMessage
          ? "documento"
          : msg.stickerMessage
            ? "figurinha"
            : null;
  if (!text && !mediaType) return null;
  return { text: text || `[${mediaType}]`, mediaType };
}

export class SessionManager {
  private sessions = new Map<string, Live>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SessionManagerDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.deps.log?.(msg, extra);
  }

  private get(sessionId: string): Live {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        sock: null,
        status: "DISCONNECTED",
        qrDataUrl: null,
        qrUpdatedAt: null,
        qrStartedAt: null,
        phone: null,
        pushName: null,
        lastError: null,
        reconnectAttempts: 0,
        stopping: false,
        clear: null,
        lastEmitted: null,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /* ------------------------------ estado ------------------------------ */

  private publicOf(s: Live): PublicStatus {
    return {
      status: s.status,
      phone: s.phone,
      pushName: s.pushName,
      qrDataUrl: s.status === "QR" ? s.qrDataUrl : null,
      qrUpdatedAt: s.qrUpdatedAt?.toISOString() ?? null,
      lastError: s.lastError,
      dryRun: this.deps.dryRun,
    };
  }

  status(sessionId: string): PublicStatus {
    const live = this.sessions.get(sessionId);
    if (live) return this.publicOf(live);
    const row = this.deps.store.getSession(sessionId);
    return {
      // Há credenciais guardadas mas o socket ainda não foi reaberto.
      status: row?.creds ? "NEEDS_RECONNECT" : "DISCONNECTED",
      phone: row?.phone ?? null,
      pushName: row?.push_name ?? null,
      qrDataUrl: null,
      qrUpdatedAt: null,
      lastError: row?.last_error ?? null,
      dryRun: this.deps.dryRun,
    };
  }

  sessionSummaries(): Array<{ id: string; status: SessionStatus }> {
    return [...this.sessions.values()].map((s) => ({ id: s.sessionId, status: s.status }));
  }

  /** Grava o estado e, se mudou de verdade, entrega ao CRM (o QR renovando não gera evento). */
  private persist(s: Live) {
    this.deps.store.saveSession(s.sessionId, {
      status: s.status,
      phone: s.phone,
      push_name: s.pushName,
      last_error: s.lastError,
    });
    const data = {
      status: s.status,
      phone: s.phone,
      push_name: s.pushName,
      last_error: s.lastError,
      dry_run: this.deps.dryRun,
    };
    const key = JSON.stringify(data);
    if (key === s.lastEmitted) return;
    s.lastEmitted = key;
    this.deps.emit({
      id: randomUUID(),
      type: "session.status",
      session_id: s.sessionId,
      occurred_at: new Date().toISOString(),
      data,
    });
  }

  /* ----------------------------- conexão ------------------------------ */

  /** Abre (ou reabre) o socket. Idempotente: já conectando/conectado, não faz nada. */
  async connect(sessionId: string): Promise<PublicStatus> {
    const s = await this.open(sessionId);
    // Dá alguns segundos para o QR (ou a reconexão com credenciais salvas) aparecer.
    for (let i = 0; i < 40 && s.status === "CONNECTING"; i++) await this.sleep(250);
    return this.publicOf(s);
  }

  private async open(sessionId: string): Promise<Live> {
    const s = this.get(sessionId);
    if (s.sock && (s.status === "CONNECTED" || s.status === "CONNECTING" || s.status === "QR")) return s;

    s.stopping = false;
    s.status = "CONNECTING";
    s.qrDataUrl = null;
    s.lastError = null;
    s.qrStartedAt = null;
    this.persist(s);

    const { state, saveCreds, clear } = sqliteAuthState(this.deps.store, sessionId);
    s.clear = clear;
    const sock = await this.deps.factory({ sessionId, state });
    s.sock = sock;

    sock.ev.on("creds.update", () => saveCreds());
    sock.ev.on("connection.update", (u: ConnectionUpdate) => void this.onConnectionUpdate(s, sock, u));
    if (this.deps.forwardMessages) this.attachMessageForwarding(s, sock);
    return s;
  }

  private async onConnectionUpdate(s: Live, sock: WaSocketLike, u: ConnectionUpdate) {
    // Eventos de um socket que já foi substituído ou encerrado não mexem no estado atual.
    if (s.sock !== sock) return;

    if (u.qr) {
      s.qrStartedAt ??= new Date();
      if (Date.now() - s.qrStartedAt.getTime() > this.deps.qrWaitMaxMs) {
        // Ninguém leu o QR a tempo: encerra em vez de renovar para sempre.
        s.stopping = true;
        s.status = "DISCONNECTED";
        s.qrDataUrl = null;
        s.qrStartedAt = null;
        s.lastError = "QR Code expirado sem leitura. Gere um novo para tentar de novo.";
        s.sock = null;
        this.persist(s);
        await sock.end(undefined);
        this.log("QR expirado sem leitura", { sessionId: s.sessionId });
        return;
      }
      // A imagem sai antes de trocar o estado: quem consulta "QR" sempre recebe a imagem junto.
      const dataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      if (s.sock !== sock) return;
      s.status = "QR";
      s.qrDataUrl = dataUrl;
      s.qrUpdatedAt = new Date();
      this.persist(s);
    }

    if (u.connection === "open") {
      s.status = "CONNECTED";
      s.qrDataUrl = null;
      s.qrStartedAt = null;
      s.reconnectAttempts = 0;
      s.phone = sock.user?.id ? jidToE164(sock.user.id) : null;
      s.pushName = sock.user?.name ?? null;
      s.lastError = null;
      this.persist(s);
      this.log("conectado", { sessionId: s.sessionId });
    }

    if (u.connection === "close") {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden;
      s.sock = null;
      s.qrDataUrl = null;
      s.lastError = u.lastDisconnect?.error?.message ?? null;

      if (loggedOut) {
        // O celular encerrou a sessão: credenciais inúteis; só um novo QR volta.
        s.status = "NEEDS_RECONNECT";
        s.phone = null;
        s.pushName = null;
        s.clear?.();
        this.persist(s);
        this.log("sessão encerrada no celular; é preciso ler o QR de novo", { sessionId: s.sessionId });
        return;
      }

      s.status = s.stopping ? "DISCONNECTED" : "CONNECTING";
      this.persist(s);
      if (s.stopping) return;
      void this.reconnectLoop(s);
    }
  }

  /** Queda de rede, `restartRequired` após o pareamento etc.: volta com espera crescente. */
  private async reconnectLoop(s: Live) {
    while (!s.stopping && !s.sock) {
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(s.reconnectAttempts, 5));
      s.reconnectAttempts += 1;
      this.log("conexão fechada; reconectando", { sessionId: s.sessionId, wait });
      await this.sleep(wait);
      if (s.stopping || s.sock) return;
      try {
        await this.open(s.sessionId);
        return;
      } catch (err) {
        s.lastError = err instanceof Error ? err.message : String(err);
        this.log("falha ao reconectar", { sessionId: s.sessionId, error: s.lastError });
      }
    }
  }

  /** Reabre as sessões que chegaram a ser pareadas (as que ficaram no QR sem leitura não voltam). */
  async restorePaired(): Promise<string[]> {
    const ids = this.deps.store.pairedSessionIds();
    for (const id of ids) {
      this.open(id).catch((err) => this.log("falha ao reabrir sessão", { sessionId: id, error: String(err) }));
    }
    return ids;
  }

  async disconnect(sessionId: string, logout: boolean): Promise<PublicStatus> {
    const s = this.get(sessionId);
    s.stopping = true;
    const sock = s.sock;
    s.sock = null;
    if (sock) {
      if (logout) await sock.logout().catch(() => {});
      else await Promise.resolve(sock.end(undefined)).catch(() => {});
    }
    if (logout) {
      // Sair apaga a sessão guardada: voltar exige ler o QR de novo, nunca
      // reconexão silenciosa. Se o socket já estava fora do ar, `clear` pode
      // não existir nesta instância, então apagamos direto no armazenamento.
      if (s.clear) s.clear();
      else this.deps.store.clearSession(sessionId);
      s.clear = null;
      s.phone = null;
      s.pushName = null;
      s.reconnectAttempts = 0;
    }
    s.status = "DISCONNECTED";
    s.qrDataUrl = null;
    this.persist(s);
    return this.publicOf(s);
  }

  async shutdown() {
    for (const s of this.sessions.values()) {
      s.stopping = true;
      await Promise.resolve(s.sock?.end(undefined)).catch(() => {});
    }
  }

  /* ----------------------- consulta e envio simulado ------------------- */

  private connectedSocket(sessionId: string): WaSocketLike {
    const s = this.sessions.get(sessionId);
    if (!s?.sock || s.status !== "CONNECTED") {
      throw new GatewayError(503, "DISCONNECTED", "WhatsApp desconectado");
    }
    return s.sock;
  }

  /** O número tem WhatsApp? Consulta ao WhatsApp, sem enviar nada. */
  async recipient(sessionId: string, to: string): Promise<{ exists: boolean; jid: string | null }> {
    if (!isE164(to)) throw new GatewayError(400, "PERMANENT", "número inválido");
    const sock = this.connectedSocket(sessionId);
    const results = await sock.onWhatsApp(to.replace(/\D/g, ""));
    if (!results) throw new GatewayError(503, "TEMPORARY", "Consulta ao WhatsApp indisponível");
    const jid = recipientJid(results);
    return { exists: Boolean(jid), jid };
  }

  /**
   * Envio em modo de teste: aceita, registra e NÃO manda nada. O envio real
   * só existe na fase da política de envio (limites, janela, aprovação);
   * até lá, desligar o modo de teste não libera nada.
   */
  send(sessionId: string, input: { to: string; text: string; clientReference: string }): { providerMessageId: string; dryRun: true } {
    if (!isE164(input.to) || !input.text.trim() || input.text.length > 4_000) {
      throw new GatewayError(400, "PERMANENT", "parâmetros inválidos");
    }
    this.connectedSocket(sessionId); // desconectado nunca "aceita"
    if (!this.deps.dryRun) {
      throw new GatewayError(501, "PERMANENT", "O envio real ainda não está habilitado neste gateway (depende da política de envio).");
    }
    this.log("DRY RUN: mensagem NÃO enviada", { sessionId, chars: input.text.length, ref: input.clientReference });
    return { providerMessageId: `dryrun-${Date.now()}-${randomUUID().slice(0, 6)}`, dryRun: true };
  }

  /* ------------------- mensagens (só com a entrega ligada) ------------- */

  private attachMessageForwarding(s: Live, sock: WaSocketLike) {
    sock.ev.on("messages.upsert", (payload: { messages: RawMessage[]; type: string }) => {
      if (payload.type !== "notify" && payload.type !== "append") return;
      for (const m of payload.messages) this.forwardMessage(s, m);
    });

    sock.ev.on("messages.update", (updates: Array<{ key: RawMessage["key"]; update: { status?: number | null } }>) => {
      for (const { key, update } of updates) {
        if (!key.fromMe || !key.id || update.status === undefined || update.status === null) continue;
        const status = update.status === 2 ? "SENT" : update.status === 3 ? "DELIVERED" : update.status === 4 ? "READ" : update.status === 0 ? "FAILED" : null;
        if (!status) continue;
        this.deps.emit({
          id: `delivery:${key.id}:${status}`,
          type: "message.delivery",
          session_id: s.sessionId,
          occurred_at: new Date().toISOString(),
          data: { provider_message_id: key.id, status },
        });
      }
    });
  }

  private forwardMessage(s: Live, m: RawMessage) {
    // Status (as "histórias"), grupos, listas de transmissão e canais não são conversa.
    const statusReason = motivoDeStatus(m as Parameters<typeof motivoDeStatus>[0]);
    if (statusReason) {
      this.log("evento de status ignorado", { reason: statusReason });
      return;
    }
    const peer = individualPeer(m);
    const content = contentOf(m);
    if (!peer || !content || !m.key.id) return;

    const fromMe = Boolean(m.key.fromMe);
    this.deps.emit({
      // Id determinístico: o WhatsApp pode reentregar a mesma mensagem ao reconectar.
      id: `${fromMe ? "from_phone" : "received"}:${m.key.id}`,
      type: fromMe ? "message.from_phone" : "message.received",
      session_id: s.sessionId,
      occurred_at: new Date().toISOString(),
      data: {
        provider_message_id: m.key.id,
        peer,
        text: content.text,
        media_type: content.mediaType,
        profile_name: m.pushName ?? null,
      },
    });
  }
}

interface ConnectionUpdate {
  connection?: "open" | "close" | "connecting";
  qr?: string;
  lastDisconnect?: { error?: Error };
}
