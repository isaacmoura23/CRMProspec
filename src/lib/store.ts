import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "@/types";
import { buildSeedDatabase } from "@/lib/seed";

/**
 * Camada de persistência do modo demo/desenvolvimento.
 *
 * Em produção o data layer alvo é Supabase/PostgreSQL (migrations em
 * /database). Este store espelha o mesmo schema em um arquivo JSON
 * local (.data/db.json) para que o produto seja 100% navegável e
 * funcional sem credenciais externas.
 */

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "db.json");

type GlobalWithDb = typeof globalThis & { __crmDb?: Database };

/**
 * Coleções obrigatórias do snapshot. Um `db.json` de versão anterior faz
 * `JSON.parse` com sucesso mas quebra em runtime (`db.leads` undefined),
 * então o shape é conferido antes de o arquivo ser aceito.
 */
const REQUIRED_COLLECTIONS = [
  "users",
  "leads",
  "lead_analysis",
  "lead_score_history",
  "pipeline_stages",
  "activities",
  "notes",
  "tasks",
  "campaigns",
  "ai_generations",
  "conversations",
  "messages",
  "proposals",
  "automation_rules",
  "notifications",
  "audit_logs",
  "integrations",
  "webhooks",
  "prospecting_jobs",
] as const;

function isValidSnapshot(value: unknown): value is Database {
  if (!value || typeof value !== "object") return false;
  const db = value as Record<string, unknown>;
  if (!db.organization || typeof db.organization !== "object") return false;
  if (!db.settings || typeof db.settings !== "object") return false;
  return REQUIRED_COLLECTIONS.every((key) => Array.isArray(db[key]));
}

/** Preserva o arquivo ilegível para diagnóstico em vez de sobrescrevê-lo em silêncio. */
function quarantine(reason: string) {
  const backup = `${DB_FILE}.invalid-${Date.now()}`;
  try {
    fs.renameSync(DB_FILE, backup);
    console.error(`[store] ${reason} — arquivo preservado em ${backup}; regenerando seed`);
  } catch (err) {
    console.error(`[store] ${reason} — não foi possível preservar o arquivo:`, err);
  }
}

function load(): Database {
  if (fs.existsSync(DB_FILE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    } catch (err) {
      quarantine(`db.json ilegível (${(err as Error).message})`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (isValidSnapshot(parsed)) return parsed;
      quarantine("db.json com schema incompatível");
    }
  }
  const db = buildSeedDatabase();
  persist(db);
  return db;
}

/**
 * Em ambientes serverless (ex.: Vercel) o filesystem do projeto é
 * somente leitura: o banco demo passa a viver apenas em memória e é
 * regenerado a cada cold start — suficiente para demonstração.
 *
 * Fora desses ambientes a falha costuma ser passageira (diretório removido,
 * antivírus segurando o arquivo, disco momentaneamente cheio). Desligar a
 * gravação para sempre no primeiro erro fazia o processo seguir perdendo
 * dados em silêncio até ser reiniciado, então só o erro que indica
 * filesystem realmente somente leitura é definitivo; o resto é reavaliado.
 */
const WRITE_RETRY_MS = 30_000;
/** Códigos em que o destino está momentaneamente travado, não proibido. */
const LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

let fsWritable = true;
let retryWritesAt = 0;

/**
 * Publica o snapshot.
 *
 * O caminho normal é escrever num temporário e renomear, que é atômico. No
 * Windows esse rename falha com EPERM/EBUSY quando algo (antivírus, o
 * indexador, o watcher do dev server) está com o arquivo aberto naquele
 * instante — situação passageira e comum, não uma proibição. Nesse caso
 * escrevemos por cima: abre mão da atomicidade para não perder a escrita.
 */
function writeSnapshot(json: string) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, "utf-8");
  try {
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !LOCKED_CODES.has(code)) throw err;
    fs.writeFileSync(DB_FILE, json, "utf-8");
    fs.rmSync(tmp, { force: true });
  }
}

function persist(db: Database) {
  if (!fsWritable && Date.now() < retryWritesAt) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    writeSnapshot(JSON.stringify(db, null, 2));
    if (!fsWritable) {
      fsWritable = true;
      console.info("[store] gravação em disco restabelecida");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Só um filesystem declaradamente somente leitura (serverless) é
    // definitivo; qualquer outra falha é reavaliada, senão o processo segue
    // perdendo dados em silêncio até ser reiniciado.
    const permanent = code === "EROFS";
    if (fsWritable) {
      console.warn(
        permanent
          ? "[store] filesystem somente leitura — operando em memória"
          : `[store] falha ao gravar (${code ?? "erro"}) — nova tentativa em ${WRITE_RETRY_MS / 1000}s`
      );
    }
    fsWritable = false;
    retryWritesAt = permanent ? Number.POSITIVE_INFINITY : Date.now() + WRITE_RETRY_MS;
  }
}

export function getDb(): Database {
  const g = globalThis as GlobalWithDb;
  if (!g.__crmDb) g.__crmDb = load();
  return g.__crmDb;
}

/**
 * Grava o snapshot imediatamente.
 *
 * A versão anterior usava debounce de 150 ms sem await: em serverless a
 * função é congelada assim que a resposta HTTP sai, então o timer nunca
 * disparava e a escrita já confirmada na UI se perdia. O snapshot demo é
 * pequeno o bastante para a gravação síncrona não pesar.
 */
export function saveDb() {
  const g = globalThis as GlobalWithDb;
  if (!g.__crmDb) return;
  try {
    persist(g.__crmDb);
  } catch (err) {
    console.error("[store] falha ao persistir banco local:", err);
  }
}

export function resetDb(): Database {
  const g = globalThis as GlobalWithDb;
  g.__crmDb = buildSeedDatabase();
  persist(g.__crmDb);
  return g.__crmDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysFromNow(days: number, hour?: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  if (hour !== undefined) d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
