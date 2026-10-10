import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Armazenamento do gateway: um arquivo SQLite só dele.
 *
 * O gateway **não** acessa o Supabase. Ele guarda aqui duas coisas:
 *   - a sessão do Baileys (credenciais e chaves de sinal), para reiniciar sem
 *     novo QR Code;
 *   - a caixa de saída (outbox) dos eventos a entregar ao CRM, para um CRM fora
 *     do ar não perder a resposta de um lead.
 *
 * Os dois ficam fora do banco do CRM de propósito: o plano gratuito do Supabase
 * pausa por inatividade, e perder a sessão derruba o número e exige novo QR.
 *
 * SQLite embutido do Node (`node:sqlite`): sem servidor, sem dependência nativa
 * para compilar, e uma cópia do arquivo é um backup.
 */

export type SessionStatus = "DISCONNECTED" | "QR" | "CONNECTING" | "CONNECTED" | "NEEDS_RECONNECT";

export interface SessionRow {
  session_id: string;
  creds: string | null;
  status: SessionStatus;
  phone: string | null;
  push_name: string | null;
  last_error: string | null;
  updated_at: string;
}

export type OutboxState = "pending" | "delivered" | "dead";

export interface OutboxRow {
  id: number;
  event_id: string;
  session_id: string;
  type: string;
  payload: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

/** Acima disto, eventos de estado antigos (já superados pelos novos) são descartados. */
const PENDING_CAP = 5_000;

export class GatewayStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        creds TEXT,
        status TEXT NOT NULL DEFAULT 'DISCONNECTED',
        phone TEXT,
        push_name TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_keys (
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        key_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, category, key_id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (state, id);
    `);
  }

  close() {
    this.db.close();
  }

  /* ------------------------------ sessão ------------------------------ */

  getSession(sessionId: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return (row as unknown as SessionRow | undefined) ?? null;
  }

  /** Cria ou atualiza só os campos informados. */
  saveSession(sessionId: string, patch: Partial<Omit<SessionRow, "session_id" | "updated_at">>) {
    const current = this.getSession(sessionId);
    const next: SessionRow = {
      session_id: sessionId,
      creds: patch.creds !== undefined ? patch.creds : (current?.creds ?? null),
      status: patch.status ?? current?.status ?? "DISCONNECTED",
      phone: patch.phone !== undefined ? patch.phone : (current?.phone ?? null),
      push_name: patch.push_name !== undefined ? patch.push_name : (current?.push_name ?? null),
      last_error: patch.last_error !== undefined ? patch.last_error : (current?.last_error ?? null),
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, creds, status, phone, push_name, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           creds = excluded.creds, status = excluded.status, phone = excluded.phone,
           push_name = excluded.push_name, last_error = excluded.last_error, updated_at = excluded.updated_at`
      )
      .run(next.session_id, next.creds, next.status, next.phone, next.push_name, next.last_error, next.updated_at);
    return next;
  }

  /** Sessões que chegaram a ser pareadas: só estas voltam sozinhas ao subir o gateway. */
  pairedSessionIds(): string[] {
    const rows = this.db.prepare("SELECT session_id, creds FROM sessions WHERE creds IS NOT NULL").all() as Array<{
      session_id: string;
      creds: string;
    }>;
    return rows
      .filter((r) => {
        try {
          const c = JSON.parse(r.creds) as { me?: unknown; registered?: boolean };
          return Boolean(c && (c.me || c.registered));
        } catch {
          return false;
        }
      })
      .map((r) => r.session_id);
  }

  getKeys(sessionId: string, category: string, ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const stmt = this.db.prepare("SELECT value FROM session_keys WHERE session_id = ? AND category = ? AND key_id = ?");
    for (const id of ids) {
      const row = stmt.get(sessionId, category, id) as { value: string } | undefined;
      if (row) out.set(id, row.value);
    }
    return out;
  }

  /** Várias chaves de uma vez, numa transação: o Baileys grava em rajada. */
  setKeys(sessionId: string, entries: Array<{ category: string; id: string; value: string | null }>) {
    if (entries.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO session_keys (session_id, category, key_id, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, category, key_id) DO UPDATE SET value = excluded.value`
    );
    const remove = this.db.prepare("DELETE FROM session_keys WHERE session_id = ? AND category = ? AND key_id = ?");
    this.db.exec("BEGIN");
    try {
      for (const e of entries) {
        if (e.value === null) remove.run(sessionId, e.category, e.id);
        else upsert.run(sessionId, e.category, e.id, e.value);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Apaga credenciais e chaves: voltar exige ler o QR Code de novo. */
  clearSession(sessionId: string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM session_keys WHERE session_id = ?").run(sessionId);
      this.db.prepare("UPDATE sessions SET creds = NULL, phone = NULL, push_name = NULL, updated_at = ? WHERE session_id = ?").run(
        new Date().toISOString(),
        sessionId
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* ------------------------------ outbox ------------------------------ */

  /** Idempotente pelo id do evento: enfileirar duas vezes o mesmo evento é inofensivo. */
  enqueue(event: { id: string; session_id: string; type: string; payload: string }, now = Date.now()) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (event_id, session_id, type, payload, state, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
      )
      .run(event.id, event.session_id, event.type, event.payload, now, now);

    // Fila gigante = CRM fora do ar por muito tempo. Estados antigos já foram
    // superados pelos novos; mensagens não, então só os primeiros são descartados.
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number };
    if (n > PENDING_CAP) {
      this.db
        .prepare(
          `DELETE FROM outbox WHERE id IN (
             SELECT id FROM outbox WHERE state = 'pending' AND type = 'session.status' ORDER BY id LIMIT ?
           )`
        )
        .run(n - PENDING_CAP);
    }
  }

  /** Os primeiros pendentes, em ordem de chegada (FIFO estrito). */
  pending(limit = 20): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE state = 'pending' ORDER BY id LIMIT ?")
      .all(limit) as unknown as OutboxRow[];
  }

  markDelivered(id: number) {
    this.db.prepare("UPDATE outbox SET state = 'delivered', last_error = NULL WHERE id = ?").run(id);
  }

  markDead(id: number, reason: string) {
    this.db.prepare("UPDATE outbox SET state = 'dead', last_error = ? WHERE id = ?").run(reason.slice(0, 300), id);
  }

  markRetry(id: number, nextAttemptAt: number, error: string) {
    this.db
      .prepare("UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(nextAttemptAt, error.slice(0, 300), id);
  }

  outboxCounts(): { pending: number; dead: number } {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state").all() as Array<{ state: string; n: number }>;
    const get = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    return { pending: get("pending"), dead: get("dead") };
  }

  /** Entregues há mais de `keepDeliveredMs` e mortos há mais de `keepDeadMs` saem. */
  purge(now = Date.now(), keepDeliveredMs = 24 * 3_600_000, keepDeadMs = 7 * 24 * 3_600_000) {
    this.db.prepare("DELETE FROM outbox WHERE state = 'delivered' AND created_at < ?").run(now - keepDeliveredMs);
    this.db.prepare("DELETE FROM outbox WHERE state = 'dead' AND created_at < ?").run(now - keepDeadMs);
  }
}
