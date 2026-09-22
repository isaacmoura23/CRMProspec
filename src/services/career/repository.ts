import "server-only";
import { getDb, saveDb } from "@/lib/store";
import { getSupabase, isSupabaseEnabled } from "@/lib/supabase";
import { emptyCareerData, type CareerData, type CareerJob } from "@/types/career";

/**
 * Persistência do módulo Carreira.
 *
 * Diferente dos leads (cache em memória com escrita espelhada), aqui cada
 * operação vai ao banco quando o Supabase está configurado: currículos,
 * candidaturas e a fila de envios não podem depender do snapshot de uma
 * instância. Sem Supabase, o mesmo contrato é atendido pelo snapshot local
 * (`db.career`), que é o modo demo.
 *
 * Toda leitura e escrita de dados do titular passa por `Owner`: o `owner_id`
 * vem sempre da sessão do servidor, nunca do cliente. As variantes `*Any`
 * existem só para o worker e para o webhook, que não têm sessão.
 */

export type CareerCollection = keyof CareerData;
export type RowOf<K extends CareerCollection> = CareerData[K][number];

export interface Owner {
  owner_id: string;
  organization_id: string;
}

export class UniqueViolationError extends Error {
  constructor(message = "Registro duplicado") {
    super(message);
    this.name = "UniqueViolationError";
  }
}

/** Preferências são únicas por titular, então a chave é o próprio owner_id. */
const KEY_FIELD: Partial<Record<CareerCollection, string>> = { preferences: "owner_id" };

const TABLE: Record<CareerCollection, string> = {
  profiles: "career_profiles",
  resumes: "career_resumes",
  analyses: "career_analyses",
  link_checks: "career_link_checks",
  preferences: "career_preferences",
  jobs: "career_jobs",
  matches: "career_matches",
  campaigns: "career_campaigns",
  applications: "career_applications",
  attempts: "career_attempts",
  events: "career_events",
  queue: "career_queue",
  connections: "career_connections",
  webhook_receipts: "career_webhook_receipts",
};

type Where<K extends CareerCollection> = Partial<RowOf<K>>;

export interface CareerRepo {
  list<K extends CareerCollection>(owner: Owner, col: K, where?: Where<K>): Promise<RowOf<K>[]>;
  get<K extends CareerCollection>(owner: Owner, col: K, id: string): Promise<RowOf<K> | null>;
  insert<K extends CareerCollection>(col: K, row: RowOf<K>): Promise<RowOf<K>>;
  update<K extends CareerCollection>(
    owner: Owner,
    col: K,
    id: string,
    patch: Partial<RowOf<K>>
  ): Promise<RowOf<K> | null>;
  remove<K extends CareerCollection>(owner: Owner, col: K, where: Where<K>): Promise<number>;

  /* Sem sessão: worker e webhooks. */
  getAny<K extends CareerCollection>(col: K, id: string): Promise<RowOf<K> | null>;
  findAny<K extends CareerCollection>(col: K, where: Where<K>): Promise<RowOf<K>[]>;
  updateAny<K extends CareerCollection>(
    col: K,
    id: string,
    patch: Partial<RowOf<K>>
  ): Promise<RowOf<K> | null>;

  /** Pega o próximo job vencido e o tranca por `leaseMs`. Atômico por instância/banco. */
  claimJob(lockOwner: string, leaseMs: number): Promise<CareerJob | null>;
  extendLease(jobId: string, lockOwner: string, leaseMs: number): Promise<boolean>;
  /** Quantos jobs estão vencidos e destrancados — decide se vale acordar o worker. */
  countDueJobs(): Promise<number>;
}

function matches<T extends object>(row: T, where: Partial<T>): boolean {
  return (Object.keys(where) as Array<keyof T>).every((k) => row[k] === where[k]);
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Snapshot local (modo demo)                                          */
/* ------------------------------------------------------------------ */

export function getCareerData(): CareerData {
  const db = getDb();
  if (!db.career) db.career = emptyCareerData();
  // Snapshots de versões anteriores podem não ter todas as coleções.
  const empty = emptyCareerData();
  for (const key of Object.keys(empty) as CareerCollection[]) {
    if (!Array.isArray(db.career[key])) (db.career as unknown as Record<string, unknown[]>)[key] = [];
  }
  return db.career;
}

/** Restrições de unicidade que o banco garante e o snapshot precisa imitar. */
function checkLocalUnique<K extends CareerCollection>(col: K, row: RowOf<K>, rows: RowOf<K>[]) {
  const key = KEY_FIELD[col] ?? "id";
  const id = (row as unknown as Record<string, unknown>)[key];
  if (rows.some((r) => (r as unknown as Record<string, unknown>)[key] === id)) {
    throw new UniqueViolationError(`Já existe um registro com ${key}=${String(id)}`);
  }
  if (col === "applications") {
    const a = row as CareerData["applications"][number];
    const dup = (rows as CareerData["applications"]).some(
      (r) =>
        r.profile_id === a.profile_id &&
        r.canonical_key === a.canonical_key &&
        r.processing_status !== "cancelada"
    );
    if (dup) throw new UniqueViolationError("Já existe candidatura para esta vaga.");
  }
  if (col === "jobs") {
    const j = row as CareerData["jobs"][number];
    if ((rows as CareerData["jobs"]).some((r) => r.owner_id === j.owner_id && r.canonical_key === j.canonical_key)) {
      throw new UniqueViolationError("Vaga já registrada.");
    }
  }
}

class LocalCareerRepo implements CareerRepo {
  private rows<K extends CareerCollection>(col: K): RowOf<K>[] {
    return getCareerData()[col] as RowOf<K>[];
  }

  private idOf<K extends CareerCollection>(col: K, row: RowOf<K>): string {
    return String((row as unknown as Record<string, unknown>)[KEY_FIELD[col] ?? "id"]);
  }

  async list<K extends CareerCollection>(owner: Owner, col: K, where: Where<K> = {}) {
    return this.rows(col).filter(
      (r) =>
        (r as unknown as Record<string, unknown>).owner_id === owner.owner_id && matches(r, where)
    );
  }

  async get<K extends CareerCollection>(owner: Owner, col: K, id: string) {
    const row = this.rows(col).find((r) => this.idOf(col, r) === id);
    if (!row || (row as unknown as Record<string, unknown>).owner_id !== owner.owner_id) return null;
    return row;
  }

  async insert<K extends CareerCollection>(col: K, row: RowOf<K>) {
    const rows = this.rows(col);
    checkLocalUnique(col, row, rows);
    rows.push(row);
    saveDb();
    return row;
  }

  async update<K extends CareerCollection>(owner: Owner, col: K, id: string, patch: Partial<RowOf<K>>) {
    const row = await this.get(owner, col, id);
    if (!row) return null;
    Object.assign(row, patch);
    saveDb();
    return row;
  }

  async remove<K extends CareerCollection>(owner: Owner, col: K, where: Where<K>) {
    const data = getCareerData();
    const before = data[col].length;
    (data[col] as RowOf<K>[]) = (data[col] as RowOf<K>[]).filter(
      (r) => !((r as unknown as Record<string, unknown>).owner_id === owner.owner_id && matches(r, where))
    ) as CareerData[K];
    saveDb();
    return before - data[col].length;
  }

  async getAny<K extends CareerCollection>(col: K, id: string) {
    return this.rows(col).find((r) => this.idOf(col, r) === id) ?? null;
  }

  async findAny<K extends CareerCollection>(col: K, where: Where<K>) {
    return this.rows(col).filter((r) => matches(r, where));
  }

  async updateAny<K extends CareerCollection>(col: K, id: string, patch: Partial<RowOf<K>>) {
    const row = await this.getAny(col, id);
    if (!row) return null;
    Object.assign(row, patch);
    saveDb();
    return row;
  }

  async claimJob(lockOwner: string, leaseMs: number) {
    const now = nowIso();
    const job = this.rows("queue")
      .filter(
        (j) =>
          (j.status === "pendente" || j.status === "processando") &&
          j.next_run_at <= now &&
          (!j.locked_until || j.locked_until < now)
      )
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))[0];
    if (!job) return null;
    job.status = "processando";
    job.lock_owner = lockOwner;
    job.locked_until = new Date(Date.now() + leaseMs).toISOString();
    job.updated_at = now;
    saveDb();
    return job;
  }

  async extendLease(jobId: string, lockOwner: string, leaseMs: number) {
    const job = this.rows("queue").find((j) => j.id === jobId);
    if (!job || job.lock_owner !== lockOwner || job.status !== "processando") return false;
    job.locked_until = new Date(Date.now() + leaseMs).toISOString();
    saveDb();
    return true;
  }

  async countDueJobs() {
    const now = nowIso();
    return this.rows("queue").filter(
      (j) =>
        (j.status === "pendente" || j.status === "processando") &&
        j.next_run_at <= now &&
        (!j.locked_until || j.locked_until < now)
    ).length;
  }
}

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

class SupabaseCareerRepo implements CareerRepo {
  private sb() {
    const sb = getSupabase();
    if (!sb) throw new Error("Supabase não configurado");
    return sb;
  }

  private key(col: CareerCollection) {
    return KEY_FIELD[col] ?? "id";
  }

  async list<K extends CareerCollection>(owner: Owner, col: K, where: Where<K> = {}) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .select("*")
      .eq("owner_id", owner.owner_id)
      .match(where as Record<string, unknown>);
    if (error) throw error;
    return (data ?? []) as RowOf<K>[];
  }

  async get<K extends CareerCollection>(owner: Owner, col: K, id: string) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .select("*")
      .eq("owner_id", owner.owner_id)
      .eq(this.key(col), id)
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  async insert<K extends CareerCollection>(col: K, row: RowOf<K>) {
    const { error } = await this.sb().from(TABLE[col]).insert(row as unknown as Record<string, unknown>);
    if (error) {
      if (isUniqueViolation(error)) throw new UniqueViolationError(error.message);
      throw error;
    }
    return row;
  }

  async update<K extends CareerCollection>(owner: Owner, col: K, id: string, patch: Partial<RowOf<K>>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .update(patch as Record<string, unknown>)
      .eq("owner_id", owner.owner_id)
      .eq(this.key(col), id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  async remove<K extends CareerCollection>(owner: Owner, col: K, where: Where<K>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .delete()
      .eq("owner_id", owner.owner_id)
      .match(where as Record<string, unknown>)
      .select(this.key(col));
    if (error) throw error;
    return data?.length ?? 0;
  }

  async getAny<K extends CareerCollection>(col: K, id: string) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .select("*")
      .eq(this.key(col), id)
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  async findAny<K extends CareerCollection>(col: K, where: Where<K>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .select("*")
      .match(where as Record<string, unknown>);
    if (error) throw error;
    return (data ?? []) as RowOf<K>[];
  }

  async updateAny<K extends CareerCollection>(col: K, id: string, patch: Partial<RowOf<K>>) {
    const { data, error } = await this.sb()
      .from(TABLE[col])
      .update(patch as Record<string, unknown>)
      .eq(this.key(col), id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data as RowOf<K> | null) ?? null;
  }

  /**
   * Duas instâncias podem ver o mesmo job vencido; o UPDATE condicional
   * (status ainda pendente/lease expirado) garante que só uma o leva.
   */
  async claimJob(lockOwner: string, leaseMs: number) {
    const now = nowIso();
    const lockFilter = `locked_until.is.null,locked_until.lt.${now}`;
    const { data: candidates, error } = await this.sb()
      .from(TABLE.queue)
      .select("*")
      .in("status", ["pendente", "processando"])
      .lte("next_run_at", now)
      .or(lockFilter)
      .order("next_run_at", { ascending: true })
      .limit(5);
    if (error) throw error;

    for (const candidate of (candidates ?? []) as CareerJob[]) {
      const { data, error: claimError } = await this.sb()
        .from(TABLE.queue)
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
      if (data && data.length === 1) return data[0] as CareerJob;
    }
    return null;
  }

  async extendLease(jobId: string, lockOwner: string, leaseMs: number) {
    const { data, error } = await this.sb()
      .from(TABLE.queue)
      .update({ locked_until: new Date(Date.now() + leaseMs).toISOString() })
      .eq("id", jobId)
      .eq("lock_owner", lockOwner)
      .eq("status", "processando")
      .select("id");
    if (error) throw error;
    return (data?.length ?? 0) === 1;
  }

  async countDueJobs() {
    const now = nowIso();
    const { count, error } = await this.sb()
      .from(TABLE.queue)
      .select("id", { count: "exact", head: true })
      .in("status", ["pendente", "processando"])
      .lte("next_run_at", now)
      .or(`locked_until.is.null,locked_until.lt.${now}`);
    if (error) throw error;
    return count ?? 0;
  }
}

/* ------------------------------------------------------------------ */

type GlobalWithRepo = typeof globalThis & { __careerRepo?: CareerRepo };

export function careerRepo(): CareerRepo {
  const g = globalThis as GlobalWithRepo;
  if (!g.__careerRepo) {
    g.__careerRepo = isSupabaseEnabled() ? new SupabaseCareerRepo() : new LocalCareerRepo();
  }
  return g.__careerRepo;
}

export function careerStorageMode(): "supabase" | "local" {
  return isSupabaseEnabled() ? "supabase" : "local";
}
