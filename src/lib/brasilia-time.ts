/**
 * Horário de Brasília (America/Sao_Paulo é UTC−3 o ano todo desde 2019). Puro e sem dependência de Node,
 * para valer no servidor e no navegador (campo "datetime-local" e textos do calendário).
 */

const OFFSET_MS = 3 * 3_600_000;

/**
 * Data e hora do campo "datetime-local" (AAAA-MM-DDTHH:mm), preenchidas no horário de Brasília,
 * convertidas em instante. `null` se o formato não for esse.
 */
export function parseBrasiliaLocal(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Instante → valor do campo "datetime-local" no horário de Brasília. */
export function toBrasiliaLocal(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t - OFFSET_MS).toISOString().slice(0, 16);
}

/** "12/10 às 12:00" no horário de Brasília. */
export function formatBrasilia(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t - OFFSET_MS).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)} às ${d.slice(11, 16)}`;
}

/** "ter 13/10" para o título de um dia do calendário (a entrada é AAAA-MM-DD). */
export function formatCalendarDay(day: string): string {
  const names = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const g = new Date(`${day}T12:00:00Z`).getUTCDay();
  return `${names[g]} ${day.slice(8, 10)}/${day.slice(5, 7)}`;
}
