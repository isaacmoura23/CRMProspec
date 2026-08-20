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

function load(): Database {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, "utf-8");
      return JSON.parse(raw) as Database;
    } catch {
      // arquivo corrompido — regenera o seed
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
    const tmp = `${DB_FILE}.tmp`;
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

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Salva com debounce para não bloquear ações em rajada */
export function saveDb() {
  const g = globalThis as GlobalWithDb;
  if (!g.__crmDb) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      persist((globalThis as GlobalWithDb).__crmDb!);
    } catch (err) {
      console.error("[store] falha ao persistir banco local:", err);
    }
  }, 150);
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
