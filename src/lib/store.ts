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
 */
let fsWritable = true;

function persist(db: Database) {
  if (!fsWritable) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Temporário por processo: dois workers do `next dev` gravando no mesmo
    // nome intercalariam bytes e o rename publicaria um JSON truncado.
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
    fs.renameSync(tmp, DB_FILE);
  } catch {
    fsWritable = false;
    console.warn("[store] filesystem somente leitura — operando em memória");
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
