import { localParts, normalizeBrazilianPhone, SP_TZ } from "@/lib/outreach-policy";

/**
 * Regras puras da conversa do Vendedor — testáveis sem servidor, sem modelo e
 * sem rede.
 *
 * O texto que o lead escreve é DADO, nunca instrução. Tudo o que decide algo
 * importante (parar de falar, para quem responder, que horário propor, se a
 * resposta pode sair) está aqui, em código determinístico: um modelo, quando há,
 * só sugere uma categoria dentro de uma lista fechada.
 */

/* ------------------------------------------------------------------ */
/* Texto                                                               */
/* ------------------------------------------------------------------ */

/** Minúsculas, sem acento, sem pontuação solta: a base de todas as regras. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Pedido para parar (antes de qualquer modelo)                        */
/* ------------------------------------------------------------------ */

const STOP_WORDS = /^(pare|para|parar|stop|sair|saia|remover|remova|cancelar|cancela|descadastrar|descadastre|chega|basta)( por favor| pfv| obrigado| obrigada)?$/;

const STOP_PHRASES: RegExp[] = [
  /\b(pare|para|parem|parar) (de )?(me )?(mandar|enviar|chamar|ligar|insistir|escrever|incomodar|importunar|procurar)/,
  /\bnao (quero|desejo|preciso) (mais )?(receber|ser contatad[oa]|mensagens?|contato|ligacoes?)/,
  /\bnao me (envie|mande|chame|procure|escreva|incomode|ligue|contate)/,
  /\b(me )?(remov\w*|exclu\w*|tir\w*|delet\w*|apag\w*) (da|dessa|desta|de sua|de suas|dos?) (lista|contatos?|cadastro|base)/,
  /\b(sair|saia|sai) da (lista|base)/,
  /\bdescadastr/,
  /\bnumero errado\b|\bengano\b/,
  /\bdenunci|\bspam\b|\bprocon\b|\blgpd\b|\bvou (te )?bloquear\b/,
];

/** Recusa curta ("não quero", "sem interesse"): trata-se como pedido para parar. */
const SHORT_REFUSAL = /^(nao quero|nao tenho interesse|sem interesse|nao obrigad[oa])( no momento| agora| mais)?( obrigad[oa])?$/;

/**
 * O lead pediu para não ser mais contatado?
 *
 * Roda ANTES de qualquer classificação por modelo e não depende dele. Na
 * dúvida entre parar e insistir, para: errar para o lado do silêncio custa uma
 * venda; errar para o outro custa o número.
 */
export function detectOptOut(text: string): boolean {
  const n = normalizeText(text);
  if (!n) return false;
  if (STOP_WORDS.test(n)) return true;
  if (SHORT_REFUSAL.test(n)) return true;
  return STOP_PHRASES.some((re) => re.test(n));
}

/* ------------------------------------------------------------------ */
/* Telefone                                                            */
/* ------------------------------------------------------------------ */

/**
 * Todas as grafias dígitos-só que designam o mesmo celular brasileiro: com e
 * sem o nono dígito. O WhatsApp ainda entrega alguns números antigos sem o 9.
 */
export function phoneEquivalents(phone: string | null | undefined): string[] {
  const e164 = normalizeBrazilianPhone(phone);
  if (!e164) return phone ? [phone.replace(/\D/g, "")].filter(Boolean) : [];
  const d = e164.slice(1);
  const out = new Set([d]);
  if (d.length === 13 && d[4] === "9") out.add(d.slice(0, 4) + d.slice(5));
  if (d.length === 12 && /^[6-9]/.test(d[4]!)) out.add(d.slice(0, 4) + "9" + d.slice(4));
  return [...out];
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneEquivalents(a);
  if (left.length === 0) return false;
  const right = new Set(phoneEquivalents(b));
  return left.some((k) => right.has(k));
}

/* ------------------------------------------------------------------ */
/* Horários de reunião                                                 */
/* ------------------------------------------------------------------ */

export interface MeetingAvailability {
  /** Dias da semana (ISO, 1 = segunda … 7 = domingo). */
  days: number[];
  startHour: number;
  endHour: number;
  /** Antecedência mínima entre agora e o primeiro horário proposto. */
  minNoticeHours: number;
  durationMin: number;
}

/** Horas preferidas, em ordem: meio da manhã e começo da tarde costumam ter mais resposta. */
const PREFERRED_HOURS = [10, 14, 11, 15, 16, 9, 17];

const WEEKDAY_NAME = ["", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"];
const WEEKDAY_SHORT = ["", "segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];

/**
 * Propõe até `count` horários, em dias diferentes, dentro da disponibilidade.
 * Varre de 30 em 30 minutos usando o fuso (sem aritmética de fuso à mão) e
 * evita os horários já ocupados.
 */
export function proposeSlots(now: Date, a: MeetingAvailability, opts: { count?: number; busy?: Date[]; tz?: string } = {}): Date[] {
  const count = opts.count ?? 2;
  const tz = opts.tz ?? SP_TZ;
  if (a.days.length === 0 || a.startHour >= a.endHour) return [];
  const hours = PREFERRED_HOURS.filter((h) => h >= a.startHour && h + a.durationMin / 60 <= a.endHour);
  if (hours.length === 0) return [];

  const busy = (opts.busy ?? []).map((d) => d.getTime());
  const earliest = now.getTime() + a.minNoticeHours * 3_600_000;
  const step = 30 * 60_000;
  const limit = now.getTime() + 21 * 86_400_000;
  const free = (t: number) => busy.every((b) => Math.abs(b - t) >= a.durationMin * 60_000);

  // Todos os horários possíveis, em ordem de tempo.
  const candidates: Array<{ at: Date; day: string; hour: number }> = [];
  for (let t = Math.ceil(earliest / step) * step; t <= limit; t += step) {
    const p = localParts(new Date(t), tz);
    if (p.minute !== 0 || !a.days.includes(p.weekday) || !hours.includes(p.hour) || !free(t)) continue;
    candidates.push({ at: new Date(t), day: p.day, hour: p.hour });
  }

  // O primeiro é o mais cedo; os seguintes ficam em dias diferentes e, se der, em horas diferentes (mais escolha para o lead).
  const chosen = candidates.slice(0, 1);
  while (chosen.length > 0 && chosen.length < count) {
    const days = new Set(chosen.map((c) => c.day));
    const hoursUsed = new Set(chosen.map((c) => c.hour));
    const others = candidates.filter((c) => !days.has(c.day));
    const next = others.find((c) => !hoursUsed.has(c.hour)) ?? others[0];
    if (!next) break;
    chosen.push(next);
  }
  return chosen.map((c) => c.at);
}

/** "terça-feira, 14/10, às 14h" — como o horário aparece para o lead. */
export function formatSlot(date: Date, tz: string = SP_TZ): string {
  const p = localParts(date, tz);
  const [, month, day] = p.day.split("-");
  const hh = p.minute === 0 ? `${p.hour}h` : `${p.hour}h${String(p.minute).padStart(2, "0")}`;
  return `${WEEKDAY_NAME[p.weekday]}, ${day}/${month}, às ${hh}`;
}

/** Versão curta para o painel e o aviso ao dono. */
export function formatSlotShort(date: Date, tz: string = SP_TZ): string {
  const p = localParts(date, tz);
  const [, month, day] = p.day.split("-");
  return `${WEEKDAY_SHORT[p.weekday]} ${day}/${month} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Qual dos horários propostos o lead escolheu? `null` quando não dá para saber
 * com segurança (nada casa, ou mais de um casa): nesse caso a conversa passa
 * para uma pessoa em vez de adivinhar.
 */
export function parseSlotChoice(text: string, slots: Date[], tz: string = SP_TZ): number | null {
  if (slots.length === 0) return null;
  const n = normalizeText(text);
  if (!n) return null;

  const ordinals: Array<[RegExp, number]> = [
    [/^(1|um)$|\b(opcao|numero|alternativa|horario) (1|um)\b|\b(a |o )?primeir[oa]\b/, 0],
    [/^(2|dois)$|\b(opcao|numero|alternativa|horario) (2|dois)\b|\b(a |o )?segund[oa]\b/, 1],
  ];
  const byOrdinal = ordinals.filter(([re, idx]) => idx < slots.length && re.test(n)).map(([, idx]) => idx);
  if (byOrdinal.length === 1) return byOrdinal[0]!;
  if (byOrdinal.length > 1) return null;

  const matches = slots
    .map((slot, idx) => {
      const p = localParts(slot, tz);
      const dayName = normalizeText(WEEKDAY_SHORT[p.weekday]!);
      const byDay = new RegExp(`\\b${dayName}\\b`).test(n);
      const byHour = new RegExp(`\\b(as )?${p.hour}( ?h| horas|:00| e ${String(p.minute).padStart(2, "0")})?\\b`).test(n) && /\b\d{1,2}( ?h|:\d{2}| horas)\b|\bas \d{1,2}\b/.test(n);
      return { idx, byDay, byHour };
    })
    .filter((m) => m.byDay || m.byHour);
  if (matches.length === 1) return matches[0]!.idx;
  // Dia E hora de um mesmo horário: tem de apontar exatamente para um.
  const both = matches.filter((m) => m.byDay && m.byHour);
  return both.length === 1 ? both[0]!.idx : null;
}

/** Concordância genérica ("pode ser", "fechado") sem apontar horário: serve só para quando há UM horário em jogo. */
export function isPlainAgreement(text: string): boolean {
  const n = normalizeText(text);
  return /^(sim|pode ser|pode|fechado|combinado|ok|blz|beleza|perfeito|otimo|show|vamos|bora|tudo certo|certo)( (pode ser|fechado|combinado|obrigad[oa]))?$/.test(n);
}

/* ------------------------------------------------------------------ */
/* Respostas ao lead                                                   */
/* ------------------------------------------------------------------ */

export type ReplyKind = "propor_horarios" | "confirmar_reuniao" | "retorno_futuro" | "sem_prioridade" | "ja_possui_fornecedor" | "preco";

export interface ReplyContext {
  /** Primeiro nome da pessoa — só se veio de uma pessoa (o chamador decide). */
  contactName?: string | null;
  /** Nome de quem escreve (perfil da empresa). */
  senderName?: string | null;
  /** Horários já formatados para o lead. */
  slots?: string[];
  /** Horário confirmado, formatado. */
  confirmed?: string;
}

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

function greeting(ctx: ReplyContext): string {
  const n = firstName(ctx.contactName);
  return n ? `Oi, ${n}!` : "Oi!";
}

function slotQuestion(slots: string[]): string {
  if (slots.length === 0) return "Qual dia e horário ficam melhores para você?";
  if (slots.length === 1) return `Consigo ${slots[0]}. Funciona para você?`;
  return `Consigo ${slots[0]} ou ${slots[1]}. Qual funciona melhor para você?`;
}

/**
 * Textos das respostas. São curtos de propósito, falam do que o lead disse e
 * não inventam preço, prazo, condição nem garantia. Nunca afirmam que um site
 * já existe: isso só vale depois de o site estar pronto.
 */
export function buildReply(kind: ReplyKind, ctx: ReplyContext): string {
  const hi = greeting(ctx);
  switch (kind) {
    case "propor_horarios":
      return `${hi} Que bom ter retorno! O melhor jeito de mostrar a ideia é numa conversa rápida de uns 15 minutos, sem compromisso. ${slotQuestion(ctx.slots ?? [])}`;
    case "preco":
      return `${hi} Os valores dependem do que faz sentido para o seu negócio, por isso prefiro entender isso com você antes de falar de números. Numa conversa rápida de uns 15 minutos eu te explico as opções. ${slotQuestion(ctx.slots ?? [])}`;
    case "confirmar_reuniao":
      return `Combinado! Então fica marcado: ${ctx.confirmed}. Se surgir algum imprevisto, é só me avisar por aqui que a gente ajusta. Até lá!`;
    case "retorno_futuro":
      return `${hi} Sem problema, anotei aqui. Te procuro mais para frente, e se mudar alguma coisa antes disso é só me chamar por aqui.`;
    case "sem_prioridade":
      return `${hi} Entendo, cada momento tem as suas prioridades. Não vou insistir agora, mas fico por aqui: quando fizer sentido, é só me chamar.`;
    case "ja_possui_fornecedor":
      return `${hi} Ótimo que vocês já têm quem cuide disso! Não quero atrapalhar. Se um dia precisarem de uma segunda opinião ou de algo pontual, é só me chamar por aqui.`;
  }
}

export const REPLY_MIN_CHARS = 20;
export const REPLY_MAX_CHARS = 600;

/**
 * Barreiras do texto de uma RESPOSTA — as mesmas ideias de `checkMessage`, sem a
 * exigência de tamanho e de aviso de saída que só fazem sentido em abordagem
 * fria, e com as frases proibidas do perfil da empresa (`never_say`).
 */
export function checkReply(body: string, neverSay: readonly string[] = []): string | null {
  const text = body.trim();
  if (text.length < REPLY_MIN_CHARS) return "Resposta curta demais.";
  if (text.length > REPLY_MAX_CHARS) return `Resposta longa demais (máximo ${REPLY_MAX_CHARS} caracteres).`;
  if (/\{\{|\}\}|\[(nome|empresa|cidade)\]|undefined|null\b/i.test(text)) return "Texto com variável não preenchida.";
  if (/https?:\/\/|www\./i.test(text)) return "Respostas automáticas não levam link.";
  if (/\bgarant(ido|imos|ia)\b|100\s?%|\bganhe\b|lucro certo|resultado garantido/i.test(text)) return "Promessa de resultado não é permitida.";
  if (/r\$\s?\d|\d+\s?(reais|mil reais)\b/i.test(text)) return "Respostas automáticas não citam preço.";
  const lower = normalizeText(text);
  for (const phrase of neverSay) {
    const p = normalizeText(phrase);
    if (p.length >= 4 && lower.includes(p)) return `Contém uma frase proibida pelo perfil da empresa: "${phrase}".`;
  }
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "");
  if (letters.length > 30 && upper.length / letters.length > 0.4) return "Texto em maiúsculas parece spam.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Aviso ao dono                                                       */
/* ------------------------------------------------------------------ */

/**
 * Trecho do que o lead escreveu, seguro para repetir no WhatsApp do dono:
 * sem link (nada clicável vindo de fora), sem quebra de linha, curto.
 */
export function quoteForOwner(text: string, max = 140): string {
  const clean = text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link removido]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export interface MeetingNoticeInput {
  companyName: string;
  segment: string | null;
  city: string | null;
  at: Date;
  /** O que o lead disse que demonstra interesse (texto do lead, tratado como citação). */
  interest: string | null;
  durationMin: number;
}

/** O aviso que chega ao WhatsApp pessoal do dono quando uma reunião é marcada. */
export function buildMeetingNotice(i: MeetingNoticeInput): string {
  const where = [i.segment, i.city].filter(Boolean).join(" · ");
  const lines = [
    "📅 Reunião marcada pelo Vendedor",
    `Lead: ${i.companyName}${where ? ` (${where})` : ""}`,
    `Quando: ${formatSlot(i.at)} (${i.durationMin} min)`,
  ];
  if (i.interest) lines.push(`Disse: “${quoteForOwner(i.interest)}”`);
  lines.push("Detalhes no CRM, em Agentes › Vendedor › Reuniões.");
  return lines.join("\n");
}
