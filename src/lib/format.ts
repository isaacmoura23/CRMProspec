const DATE_FMT = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const DATETIME_FMT = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const TIME_FMT = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * `Intl.DateTimeFormat.format` lança `RangeError` em data inválida — e uma
 * data ruim vinda do JSON persistido ou de um import derrubava a página
 * inteira. Aqui uma data inválida vira travessão, como um valor ausente.
 */
function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? DATE_FMT.format(d) : "—";
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? DATETIME_FMT.format(d) : "—";
}

export function formatTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? TIME_FMT.format(d) : "—";
}

export function formatCurrency(value: number, currency = "BRL"): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(value);
}

export function formatPercent(value: number, digits = 1): string {
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(value)}%`;
}

/** "há 2 dias", "há 3 horas", "agora" */
export function timeAgo(iso: string | null | undefined): string {
  const parsed = parseDate(iso);
  if (!parsed) return "—";
  const diffMs = Date.now() - parsed.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  const years = Math.floor(months / 12);
  return `há ${years} ${years === 1 ? "ano" : "anos"}`;
}

/** Dias até uma data futura (negativo se vencida) */
export function daysUntil(iso: string): number {
  const target = parseDate(iso);
  if (!target) return Infinity;
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function daysSince(iso: string | null | undefined): number {
  const parsed = parseDate(iso);
  if (!parsed) return Infinity;
  return Math.floor((Date.now() - parsed.getTime()) / 86_400_000);
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
