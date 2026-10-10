/**
 * Política de envio do Vendedor — regras puras, testáveis sem servidor.
 *
 * Existe porque abordar quem não é seu contato por um número não oficial tem
 * risco real de banimento. Estas regras não "contornam" nada: elas limitam o
 * volume e o ritmo ao que uma pessoa faria, e param a conversa quando alguém
 * pede. O que está aqui é o que decide se uma mensagem sai agora, depois ou nunca.
 *
 * Portado em espírito de `scheduling/window.ts` e `send.ts` da Cobra
 * (agenteitalo): janela por dia e horário no fuso, etapa obsoleta, tentativas.
 */

export const SP_TZ = "America/Sao_Paulo";

/* ------------------------------------------------------------------ */
/* Tempo no fuso                                                       */
/* ------------------------------------------------------------------ */

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  /** ISO: segunda = 1 … domingo = 7. */
  weekday: number;
  hour: number;
  minute: number;
  /** Dia civil no fuso (YYYY-MM-DD) — a base de "hoje" para teto e obsolescência. */
  day: string;
}

export function localParts(date: Date, tz: string = SP_TZ): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(date)) p[part.type] = part.value;
  return {
    weekday: WEEKDAYS[p.weekday!] ?? 1,
    hour: Number(p.hour),
    minute: Number(p.minute),
    day: `${p.year}-${p.month}-${p.day}`,
  };
}

/* ------------------------------------------------------------------ */
/* Janela de envio                                                     */
/* ------------------------------------------------------------------ */

export interface SendWindow {
  /** Dias da semana permitidos (ISO, 1 = segunda … 7 = domingo). */
  days: number[];
  /** Hora de início (inclusive) e de fim (exclusive), 0–24. */
  startHour: number;
  endHour: number;
  tz?: string;
}

export function isWithinWindow(now: Date, w: SendWindow): boolean {
  const p = localParts(now, w.tz);
  return w.days.includes(p.weekday) && p.hour >= w.startHour && p.hour < w.endHour;
}

/**
 * Próximo instante em que a janela abre. Varre de 5 em 5 minutos (até 9 dias):
 * resolução suficiente para decidir quando voltar a olhar a fila, sem depender
 * de aritmética de fuso à mão. Janela vazia (sem dias) devolve `null`.
 */
export function nextWindowOpen(from: Date, w: SendWindow): Date | null {
  if (w.days.length === 0 || w.startHour >= w.endHour) return null;
  if (isWithinWindow(from, w)) return from;
  const step = 5 * 60_000;
  const limit = from.getTime() + 9 * 86_400_000;
  // Alinha ao próximo múltiplo de 5 min.
  let t = Math.ceil(from.getTime() / step) * step;
  for (; t <= limit; t += step) {
    if (isWithinWindow(new Date(t), w)) return new Date(t);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Teto diário com aquecimento                                         */
/* ------------------------------------------------------------------ */

/** Teto por semana de uso do número, até chegar ao máximo configurado. */
export const WARMUP_CAPS = [10, 20, 30] as const;

/**
 * Quantas mensagens o número pode enviar hoje.
 *
 * Um número que nunca enviou nada e passa a mandar dezenas por dia é o padrão
 * que mais leva a restrição. O aquecimento sobe por semana (10, 20, 30…) até o
 * máximo do dono; nunca passa dele.
 */
export function dailyCap(daysSinceFirstSend: number | null, max: number, warmup: boolean): number {
  if (!warmup) return max;
  const week = daysSinceFirstSend === null ? 0 : Math.max(0, Math.floor(daysSinceFirstSend / 7));
  const stage = WARMUP_CAPS[week];
  return stage === undefined ? max : Math.min(max, stage);
}

/* ------------------------------------------------------------------ */
/* Intervalo entre envios                                              */
/* ------------------------------------------------------------------ */

/** Hash simples e estável (FNV-1a) → número em [0, 1). */
function unitHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100_000) / 100_000;
}

/**
 * Espera entre dois envios, aleatória dentro de [min, max] segundos.
 *
 * Derivada do id da última mensagem em vez de sorteada na hora: assim o mesmo
 * "instante liberado" vale para quem consultar de novo, sem guardar estado
 * extra, e o teste é determinístico. Mensagens espaçadas de forma irregular
 * se parecem com gente; rajadas em intervalo fixo, não.
 */
export function gapSeconds(seed: string, minSeconds: number, maxSeconds: number): number {
  const lo = Math.max(0, Math.min(minSeconds, maxSeconds));
  const hi = Math.max(minSeconds, maxSeconds);
  return Math.round(lo + unitHash(seed) * (hi - lo));
}

/* ------------------------------------------------------------------ */
/* Acompanhamentos (toques)                                            */
/* ------------------------------------------------------------------ */

/** No máximo três toques por lead, sempre. */
export const MAX_TOUCHES = 3;

/** Dias de espera depois do toque `touch` até o seguinte. */
export function touchDelayDays(touch: number, spacing: number[]): number {
  return spacing[touch - 1] ?? spacing[spacing.length - 1] ?? 3;
}

/** A etapa ficou para trás (data civil já passou) e não deve mais sair como se fosse de ontem. */
export function isStaleCycle(scheduledFor: Date, now: Date, tz: string = SP_TZ): boolean {
  return localParts(scheduledFor, tz).day < localParts(now, tz).day;
}

/* ------------------------------------------------------------------ */
/* Telefone                                                            */
/* ------------------------------------------------------------------ */

/**
 * Telefone brasileiro em E.164. Aceita "(41) 99999-8888", "041 99999 8888",
 * "+55 41 99999-8888", "5541999998888". Devolve `null` para o que não é
 * número brasileiro plausível — o Vendedor não adivinha formato.
 */
export function normalizeBrazilianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0055")) d = d.slice(2);
  // Zero de operadora/tronco antes do DDD.
  if (d.length >= 11 && d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!(d.length === 12 || d.length === 13) || !d.startsWith("55")) return null;
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  return `+${d}`;
}

/**
 * Celular brasileiro: DDD + 9 dígitos começando em 9. Fixo (começa em 2–5) quase
 * nunca tem WhatsApp, então nem se gasta uma consulta nele.
 */
export function isBrazilianMobile(e164: string): boolean {
  return /^\+55\d{2}9\d{8}$/.test(e164);
}

/** Só os dígitos: a chave da lista de bloqueio. */
export function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "");
}

/* ------------------------------------------------------------------ */
/* Conteúdo da mensagem                                                */
/* ------------------------------------------------------------------ */

/** Toda abordagem oferece uma saída. LGPD, e é o que reduz denúncia. */
export const OPT_OUT_FOOTER = "Se preferir não receber mais mensagens, é só responder PARE.";

export function withOptOutFooter(body: string): string {
  const clean = body.trim();
  return clean.includes(OPT_OUT_FOOTER) ? clean : `${clean}\n\n${OPT_OUT_FOOTER}`;
}

export const MESSAGE_MIN_CHARS = 40;
export const MESSAGE_MAX_CHARS = 900;

/**
 * Barreiras determinísticas do texto, independentes de modelo ou de quem editou.
 * Devolve o motivo da recusa, ou `null` se o texto pode seguir.
 *
 * O que NÃO dá para checar por regra (por exemplo, "criticar o trabalho atual
 * do prospect" do perfil da empresa) é coberto pelo prompt e, no modo de
 * aprovação, pela leitura do dono. Isto aqui pega o inequívoco.
 */
export function checkMessage(body: string): string | null {
  const text = body.trim();
  if (text.length < MESSAGE_MIN_CHARS) return "Mensagem curta demais para uma abordagem.";
  if (text.length > MESSAGE_MAX_CHARS) return `Mensagem longa demais (máximo ${MESSAGE_MAX_CHARS} caracteres): ninguém lê parágrafos de desconhecidos.`;
  if (/\{\{|\}\}|\[(nome|empresa|cidade)\]|undefined|null\b/i.test(text)) return "Texto com variável não preenchida.";
  if (/https?:\/\/|www\.|\b[\w-]+\.(com|net|org|app)(\.br)?\b/i.test(text)) return "A primeira abordagem não leva link: link em mensagem fria é o que mais gera denúncia.";
  if (/\bgarant(ido|imos|ia)\b|100\s?%|\bganhe\b|lucro certo|resultado garantido/i.test(text)) return "Promessa de resultado não é permitida.";
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "");
  if (letters.length > 30 && upper.length / letters.length > 0.4) return "Texto em maiúsculas parece spam.";
  return null;
}
