import "server-only";
import { getDb, saveDb } from "@/lib/store";
import { getSupabase, isSupabaseEnabled } from "@/lib/supabase";
import { emptyAgentData, type AgentData, type AgentTask, type OutreachCycle, type OwnerNotice } from "@/types/agents";

/**
 * Persistência do AgentOS.
 *
 * Mesmo desenho do módulo Carreira (`career/repository.ts`): um contrato, duas
 * implementações. Com Supabase configurado cada operação vai ao banco; sem ele,
 * o snapshot local (`db.agents`) atende o mesmo contrato — é o modo demo.
 *
 * Tudo é filtrado pela organização do snapshot (`db.organization.id`), que é a
 * mesma usada pelos leads no Supabase. Não há `owner_id`: agentes operam em
 * nome da organização, e quem pediu cada coisa fica em `created_by`.
 */

export type AgentCollection = keyof AgentData;
export type RowOf<K extends AgentCollection> = AgentData[K][number];

const TABLE: Record<AgentCollection, string> = {
  settings: "agent_settings",
  tasks: "agent_tasks",
  events: "agent_events",
  heartbeats: "agent_heartbeats",
  niche_targets: "niche_targets",
  approvals: "approvals",
  spend: "spend_ledger",
  whatsapp_link: "whatsapp_link",
  whatsapp_receipts: "whatsapp_receipts",
  outreach_cycles: "outreach_cycles",
  outreach_messages: "outreach_messages",
  channel_blocklist: "channel_blocklist",
  conversation_state: "conversation_state",
  meetings: "meetings",
  owner_notices: "owner_notices",
  lead_dossiers: "lead_dossiers",
  site_builds: "site_builds",
  social_posts: "social_posts",
  ad_campaigns: "ad_campaigns",
  ad_reports: "ad_reports",
  prospect_coverage: "prospect_coverage",
  creatives: "creatives",
};

/** Chave natural de cada coleção (o `id` em todas, exceto onde o contrato diz outra coisa). */
const KEY_FIELD: Partial<Record<AgentCollection, string>> = {};

export interface ListOptions<K extends AgentCollection> {
  where?: Partial<RowOf<K>>;
  orderBy?: keyof RowOf<K> & string;
  desc?: boolean;
  limit?: number;
}

export class UniqueViolationError extends Error {
  constructor(message = "Registro duplicado") {
    super(message);
    this.name = "UniqueViolationError";
  }
}

export interface ClaimedTask {
  task: AgentTask;
  /** Estava `processando` com lease vencido: o processo anterior morreu no meio. */
  reclaimed: boolean;
}

export interface AgentRepo {
  list<K extends AgentCollection>(col: K, opts?: ListOptions<K>): Promise<RowOf<K>[]>;
  get<K extends AgentCollection>(col: K, id: string): Promise<RowOf<K> | null>;
  insert<K extends AgentCollection>(col: K, row: RowOf<K>): Promise<RowOf<K>>;
  update<K extends AgentCollection>(col: K, id: string, patch: Partial<RowOf<K>>): Promise<RowOf<K> | null>;
  /** Insere ou substitui pela chave. Usado por configurações, batimento e nichos. */
  upsert<K extends AgentCollection>(col: K, row: RowOf<K>): Promise<RowOf<K>>;
  remove<K extends AgentCollection>(col: K, where: Partial<RowOf<K>>): Promise<number>;
  /** Remove linhas com `field` anterior a `before` (limpeza de log). */
  removeOlderThan<K extends AgentCollection>(col: K, field: keyof RowOf<K> & string, before: string): Promise<number>;

  /** Pega a próxima tarefa vencida dos agentes permitidos e a tranca por `leaseMs`. */
  claimTask(lockOwner: string, leaseMs: number, agents: readonly string[]): Promise<ClaimedTask | null>;
  extendLease(taskId: string, lockOwner: string, leaseMs: number): Promise<boolean>;
  countDueTasks(agents?: readonly string[]): Promise<number>;

  /**
   * Reivindicação atômica de um ciclo de envio: só quem o encontra `agendado`
   * leva (agendado → reivindicado). Dois processadores nunca enviam o mesmo ciclo.
   */
  claimOutreachCycle(id: string): Promise<OutreachCycle | null>;

  /**
   * Troca atômica de estado: aplica `patch` só se a linha ainda está em `from`. Quem não leva
   * recebe `null`. É o que impede dois cliques seguidos de publicar o mesmo post ou ativar a
   * mesma campanha duas vezes.
   */
  claimStatus<K extends AgentCollection>(col: K, id: string, from: string, patch: Partial<RowOf<K>>): Promise<RowOf<K> | null>;
}

function nowIso() {
  return new Date().toISOString();
}

export function orgId(): string {
  return getDb().organization.id;
}

function matches<T extends object>(row: T, where: Partial<T>): boolean {
  return (Object.keys(where) as Array<keyof T>).every((k) => row[k] === where[k]);
}

function isDue(t: AgentTask, now: string): boolean {
  return (
    (t.status === "pendente" || t.status === "processando") &&
    t.next_run_at <= now &&
    (!t.locked_until || t.locked_until < now)
  );
}

/* ------------------------------------------------------------------ */
/* Snapshot local (modo demo)                                          */
/* ------------------------------------------------------------------ */

/** Teto de eventos guardados no snapshot: o log não pode inflar o db.json sem fim. */
const LOCAL_EVENTS_CAP = 1_000;
const LOCAL_SPEND_CAP = 5_000;
const LOCAL_RECEIPTS_CAP = 2_000;

export function getAgentData(): AgentData {
  const db = getDb();
  if (!db.agents) db.agents = emptyAgentData();
  const empty = emptyAgentData();
  for (const key of Object.keys(empty) as AgentCollection[]) {
    if (!Array.isArray(db.agents[key])) (db.agents as unknown as Record<string, unknown[]>)[key] = [];
  }
  return db.agents;
}

type GlobalWithBeats = typeof globalThis & { __agentHeartbeats?: AgentData["heartbeats"] };

function keyOf<K extends AgentCollection>(col: K, row: RowOf<K>): string {
  return String((row as unknown as Record<string, unknown>)[KEY_FIELD[col] ?? "id"]);
}

class LocalAgentRepo implements AgentRepo {
  /**
   * Batimentos ficam só em memória: gravá-los no snapshot a cada poucos
   * segundos reescreveria o db.json inteiro para guardar um dado que não
   * sobrevive a reinício de qualquer forma (o runner novo cria o seu).
   */
  private rows<K extends AgentCollection>(col: K): RowOf<K>[] {
    if (col === "heartbeats") {
      const g = globalThis as GlobalWithBeats;
      g.__agentHeartbeats ??= [];
      return g.__agentHeartbeats as RowOf<K>[];
    }
    return getAgentData()[col] as RowOf<K>[];
  }

  private persist(col: AgentCollection) {
    if (col !== "heartbeats") saveDb();
  }

  private trim(col: AgentCollection) {
    const data = getAgentData();
    if (col === "events" && data.events.length > LOCAL_EVENTS_CAP) {
      data.events = data.events.slice(-LOCAL_EVENTS_CAP);
    }
    if (col === "spend" && data.spend.length > LOCAL_SPEND_CAP) {
      data.spend = data.spend.slice(-LOCAL_SPEND_CAP);
    }
    if (col === "whatsapp_receipts" && data.whatsapp_receipts.length > LOCAL_RECEIPTS_CAP) {
      data.whatsapp_receipts = data.whatsapp_receipts.slice(-LOCAL_RECEIPTS_CAP);
    }
  }

  async list<K extends AgentCollection>(col: K, opts: ListOptions<K> = {}) {
    const org = orgId();
    let rows = this.rows(col).filter(
      (r) => (r as unknown as { organization_id: string }).organization_id === org && matches(r, opts.where ?? {})
    );
    if (opts.orderBy) {
      const f = opts.orderBy;
      const dir = opts.desc ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = (a as unknown as Record<string, unknown>)[f] as string | number | null;
        const y = (b as unknown as Record<string, unknown>)[f] as string | number | null;
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * dir;
      });
    }
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async get<K extends AgentCollection>(col: K, id: string) {
    const org = orgId();
    return (
      this.rows(col).find(
        (r) => keyOf(col, r) === id && (r as unknown as { organization_id: string }).organization_id === org
      ) ?? null
    );
  }

  /** Imita as restrições de unicidade que o banco garante. */
  private checkUnique<K extends AgentCollection>(col: K, row: RowOf<K>, rows: RowOf<K>[]) {
    const org = (row as unknown as { organization_id: string }).organization_id;
    if (rows.some((r) => keyOf(col, r) === keyOf(col, row) && (r as unknown as { organization_id: string }).organization_id === org)) {
      throw new UniqueViolationError(`Já existe um registro com id=${keyOf(col, row)}`);
    }
    if (col === "outreach_cycles") {
      const c = row as unknown as OutreachCycle;
      const all = rows as unknown as OutreachCycle[];
      if (all.some((r) => r.idempotency_key === c.idempotency_key)) {
        throw new UniqueViolationError("Já existe um ciclo com esta chave de idempotência.");
      }
      // Um lead nunca tem duas abordagens ativas ao mesmo tempo.
      if (all.some((r) => r.lead_id === c.lead_id && r.organization_id === c.organization_id && (r.status === "agendado" || r.status === "reivindicado"))) {
        throw new UniqueViolationError("Este lead já tem uma abordagem em andamento.");
      }
    }
    if (col === "owner_notices") {
      const n = row as unknown as OwnerNotice;
      if ((rows as unknown as OwnerNotice[]).some((r) => r.idempotency_key === n.idempotency_key)) {
        throw new UniqueViolationError("Já existe um aviso com esta chave de idempotência.");
      }
    }
    if (col === "tasks") {
      const t = row as unknown as AgentTask;
      const live = (rows as unknown as AgentTask[]).some(
        (r) =>
          t.dedupe_key !== null &&
          r.dedupe_key === t.dedupe_key &&
          r.organization_id === t.organization_id &&
          (r.status === "pendente" || r.status === "processando")
      );
      if (live) throw new UniqueViolationError("Tarefa idêntica já está na fila.");
    }
  }

  async insert<K extends AgentCollection>(col: K, row: RowOf<K>) {
    const rows = this.rows(col);
    this.checkUnique(col, row, rows);
    rows.push(row);
    this.trim(col);
    this.persist(col);
    return row;
  }

  async update<K extends AgentCollection>(col: K, id: string, patch: Partial<RowOf<K>>) {
    const row = await this.get(col, id);
    if (!row) return null;
    Object.assign(row, patch);
    this.persist(col);
    return row;
  }

  async upsert<K extends AgentCollection>(col: K, row: RowOf<K>) {
    const existing = await this.get(col, keyOf(col, row));
    if (existing) {
      Object.assign(existing, row);
      this.persist(col);
      return existing;
    }
    const rows = this.rows(col);
    rows.push(row);
    this.trim(col);
    this.persist(col);
    return row;
  }

  async remove<K extends AgentCollection>(col: K, where: Partial<RowOf<K>>) {
    const org = orgId();
    const rows = this.rows(col);
    const keep = rows.filter(
      (r) => !((r as unknown as { organization_id: string }).organization_id === org && matches(r, where))
    );
    const removed = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    if (removed) this.persist(col);
    return removed;
  }

  async removeOlderThan<K extends AgentCollection>(col: K, field: keyof RowOf<K> & string, before: string) {
    const org = orgId();
    const rows = this.rows(col);
    const keep = rows.filter((r) => {
      const rec = r as unknown as Record<string, unknown>;
      return !(rec.organization_id === org && typeof rec[field] === "string" && (rec[field] as string) < before);
    });
    const removed = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    if (removed) this.persist(col);
    return removed;
  }

  async claimTask(lockOwner: string, leaseMs: number, agents: readonly string[]) {
    if (agents.length === 0) return null;
    const now = nowIso();
    const org = orgId();
    const task = this.rows("tasks")
      .filter((t) => t.organization_id === org && agents.includes(t.agent) && isDue(t, now))
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    if (!task) return null;
    const reclaimed = task.status === "processando";
    task.status = "processando";
    task.lock_owner = lockOwner;
    task.locked_until = new Date(Date.now() + leaseMs).toISOString();
    task.updated_at = now;
    saveDb();
    return { task, reclaimed };
  }

  async extendLease(taskId: string, lockOwner: string, leaseMs: number) {
    const task = this.rows("tasks").find((t) => t.id === taskId);
    if (!task || task.lock_owner !== lockOwner || task.status !== "processando") return false;
    task.locked_until = new Date(Date.now() + leaseMs).toISOString();
    return true;
  }

  async claimStatus<K extends AgentCollection>(col: K, id: string, from: string, patch: Partial<RowOf<K>>) {
    // Sem nenhum `await` entre ler e gravar: dois chamadores nunca passam juntos.
    const org = orgId();
    const row = this.rows(col).find((r) => keyOf(col, r) === id && (r as unknown as { organization_id: string }).organization_id === org);
    if (!row || (row as unknown as { status?: string }).status !== from) return null;
    Object.assign(row, patch);
    this.persist(col);
    return row;
  }

  async claimOutreachCycle(id: string) {
    const cycle = this.rows("outreach_cycles").find((c) => c.id === id && c.organization_id === orgId());
    if (!cycle || cycle.status !== "agendado") return null;
    cycle.status = "reivindicado";
    cycle.claimed_at = nowIso();
    cycle.updated_at = cycle.claimed_at;
    saveDb();
    return cycle;
  }

  async countDueTasks(agents?: readonly string[]) {
    const now = nowIso();
    const org = orgId();
    return this.rows("tasks").filter(
      (t) => t.organization_id === org && (!agents || agents.includes(t.agent)) && isDue(t, now)
    ).length;
  }
}

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

class SupabaseAgentRepo implements AgentRepo {
  private sb() {
    const sb = getSupabase();
    if (!sb) throw new Error("Supabase não configurado");
    return sb;
  }

  private key(col: AgentCollection) {
    return KEY_FIELD[col] ?? "id";
  }

  async list<K extends AgentCollection>(col: K, opts: ListOptions<K> = {}) {
    let q = this.sb()
      .from(TABLE[col])
      .select("*")
      .eq("organization_id", orgId())
      .match((opts.where ?? {}) as Record<string, unknown>);
    if (opts.orderBy) q = q.order(opts.orderBy, { ascending: !opts.desc });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as RowOf<K>[];
  }

  async get<K extends AgentCollection>(col: K, id: string) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .select("*")
      .eq("organization_id", orgId())
      .eq(this.key(col), id)
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  async insert<K extends AgentCollection>(col: K, row: RowOf<K>) {
    const { error } = await this.sb().from(TABLE[col]).insert(row as unknown as Record<string, unknown>);
    if (error) {
      if (isUniqueViolation(error)) throw new UniqueViolationError(error.message);
      throw error;
    }
    return row;
  }

  async update<K extends AgentCollection>(col: K, id: string, patch: Partial<RowOf<K>>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .update(patch as Record<string, unknown>)
      .eq("organization_id", orgId())
      .eq(this.key(col), id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  async upsert<K extends AgentCollection>(col: K, row: RowOf<K>) {
    const onConflict = col === "settings" ? "organization_id,id" : "id";
    const { error } = await this.sb()
      .from(TABLE[col])
      .upsert(row as unknown as Record<string, unknown>, { onConflict });
    if (error) throw error;
    return row;
  }

  async remove<K extends AgentCollection>(col: K, where: Partial<RowOf<K>>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .delete()
      .eq("organization_id", orgId())
      .match(where as Record<string, unknown>)
      .select(this.key(col));
    if (error) throw error;
    return data?.length ?? 0;
  }

  async removeOlderThan<K extends AgentCollection>(col: K, field: keyof RowOf<K> & string, before: string) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .delete()
      .eq("organization_id", orgId())
      .lt(field, before)
      .select(this.key(col));
    if (error) throw error;
    return data?.length ?? 0;
  }

  /**
   * Duas instâncias podem ver a mesma tarefa vencida; o UPDATE condicional
   * (status ainda pendente/processando e lease vencido) garante que só uma a leva.
   */
  async claimTask(lockOwner: string, leaseMs: number, agents: readonly string[]) {
    if (agents.length === 0) return null;
    const now = nowIso();
    const lockFilter = `locked_until.is.null,locked_until.lt.${now}`;
    const { data: candidates, error } = await this.sb()
      .from(TABLE.tasks)
      .select("*")
      .eq("organization_id", orgId())
      .in("agent", [...agents])
      .in("status", ["pendente", "processando"])
      .lte("next_run_at", now)
      .or(lockFilter)
      .order("next_run_at", { ascending: true })
      .limit(5);
    if (error) throw error;

    for (const candidate of (candidates ?? []) as AgentTask[]) {
      const { data, error: claimError } = await this.sb()
        .from(TABLE.tasks)
        .update({
          status: "processando",
          lock_owner: lockOwner,
          locked_until: new Date(Date.now() + leaseMs).toISOString(),
          updated_at: now,
        })
        .eq("id", candidate.id)
        .in("status", ["pendente", "processando"])
        .or(lockFilter)
        .select();
      if (claimError) throw claimError;
      if (data && data.length === 1) {
        return { task: data[0] as AgentTask, reclaimed: candidate.status === "processando" };
      }
    }
    return null;
  }

  async extendLease(taskId: string, lockOwner: string, leaseMs: number) {
    const { data, error } = await this.sb()
      .from(TABLE.tasks)
      .update({ locked_until: new Date(Date.now() + leaseMs).toISOString() })
      .eq("id", taskId)
      .eq("lock_owner", lockOwner)
      .eq("status", "processando")
      .select("id");
    if (error) throw error;
    return (data?.length ?? 0) === 1;
  }

  async claimStatus<K extends AgentCollection>(col: K, id: string, from: string, patch: Partial<RowOf<K>>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .update(patch as Record<string, unknown>)
      .eq("organization_id", orgId())
      .eq(this.key(col), id)
      .eq("status", from)
      .select();
    if (error) throw error;
    return data && data.length === 1 ? (data[0] as RowOf<K>) : null;
  }

  async claimOutreachCycle(id: string) {
    const now = nowIso();
    const { data, error } = await this.sb()
      .from(TABLE.outreach_cycles)
      .update({ status: "reivindicado", claimed_at: now, updated_at: now })
      .eq("organization_id", orgId())
      .eq("id", id)
      .eq("status", "agendado")
      .select();
    if (error) throw error;
    return data && data.length === 1 ? (data[0] as OutreachCycle) : null;
  }

  async countDueTasks(agents?: readonly string[]) {
    const now = nowIso();
    let q = this.sb()
      .from(TABLE.tasks)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId())
      .in("status", ["pendente", "processando"])
      .lte("next_run_at", now)
      .or(`locked_until.is.null,locked_until.lt.${now}`);
    if (agents) q = q.in("agent", [...agents]);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }
}

/* ------------------------------------------------------------------ */

type GlobalWithRepo = typeof globalThis & { __agentRepo?: AgentRepo };

export function agentRepo(): AgentRepo {
  const g = globalThis as GlobalWithRepo;
  if (!g.__agentRepo) {
    g.__agentRepo = isSupabaseEnabled() ? new SupabaseAgentRepo() : new LocalAgentRepo();
  }
  return g.__agentRepo;
}

/** Só para testes: força a implementação local e descarta o cache. */
export function resetAgentRepoForTests() {
  const g = globalThis as GlobalWithRepo & GlobalWithBeats;
  g.__agentRepo = new LocalAgentRepo();
  g.__agentHeartbeats = [];
}

export function agentStorageMode(): "supabase" | "local" {
  return isSupabaseEnabled() ? "supabase" : "local";
}
