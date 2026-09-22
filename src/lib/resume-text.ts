/**
 * Utilitários puros sobre o texto extraído de um currículo.
 * Sem I/O, para serem testados isoladamente.
 */

const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>()"']+|\b(?:[a-z0-9-]+\.)?(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|dribbble\.com|medium\.com|dev\.to|lattes\.cnpq\.br|credly\.com|coursera\.org|udemy\.com|vercel\.app|netlify\.app|github\.io)\/[^\s<>()"']+/gi;

/** Limpa pontuação de fim de frase que costuma colar na URL no texto do PDF. */
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/g, "");
}

export function normalizeUrl(raw: string): string | null {
  let s = trimTrailing(raw.trim());
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/\//, "")}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function extractUrlsFromText(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = normalizeUrl(m[0]);
    if (url) found.add(url);
  }
  return [...found];
}

export function extractEmails(text: string): string[] {
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  return [...new Set((text.match(re) ?? []).map((e) => e.toLowerCase()))];
}

export function extractPhones(text: string): string[] {
  // Formatos BR/PT/internacionais comuns: +55 (11) 91234-5678, 11 91234 5678, +351 912 345 678
  const re = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g;
  return [...new Set((text.match(re) ?? []).map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 10))];
}

/** Meses em pt/en para reconhecer intervalos de datas. */
const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12,
};

export interface DateRange {
  start: string | null;
  end: string | null; // null = atual
  raw: string;
}

/**
 * Reconhece "mar/2021 – atual", "2019 - 2022", "01/2020 a 06/2021", "Jan 2020 – Present".
 */
export function parseDateRange(line: string): DateRange | null {
  const re =
    /((?:\d{1,2}[\/.-])?(?:[a-zç]{3,9}[\/.\s-]?)?\d{4})\s*(?:[-–—]|a|to|até|ate)\s*((?:\d{1,2}[\/.-])?(?:[a-zç]{3,9}[\/.\s-]?)?\d{4}|atual|presente|hoje|present|current|now|o momento)/i;
  const m = re.exec(line);
  if (!m) return null;
  const norm = (s: string): string | null => {
    const t = s.toLowerCase().trim();
    if (/^(atual|presente|hoje|present|current|now|o momento)$/.test(t)) return null;
    const year = /\d{4}/.exec(t)?.[0];
    if (!year) return null;
    const numMonth = /^(\d{1,2})[\/.-]/.exec(t)?.[1];
    if (numMonth) return `${year}-${numMonth.padStart(2, "0")}`;
    const name = /^([a-zç]{3})/.exec(t)?.[1];
    if (name && MONTHS[name]) return `${year}-${String(MONTHS[name]).padStart(2, "0")}`;
    return year;
  };
  return { start: norm(m[1]!), end: norm(m[2]!), raw: m[0] };
}

/** Palavras que sinalizam seções, em pt/en. */
export const SECTION_HEADINGS: Record<string, RegExp> = {
  summary: /^(resumo|sobre|perfil|objetivo|summary|about|profile|objective)\b/i,
  experience: /^(experi[êe]ncia|hist[óo]rico profissional|experience|employment|work history|carreira)\b/i,
  education: /^(forma[çc][ãa]o|educa[çc][ãa]o|education|academic)\b/i,
  skills: /^(habilidades|compet[êe]ncias|skills|tecnologias|technologies|conhecimentos|ferramentas)\b/i,
  languages: /^(idiomas|languages|l[íi]nguas)\b/i,
  certifications: /^(certifica[çc][õo]es|certificados|certifications|cursos|courses)\b/i,
  projects: /^(projetos|projects|portf[óo]lio)\b/i,
};

export function detectSection(line: string): string | null {
  const t = line.trim().replace(/[:\-–—]+$/, "").trim();
  if (t.length === 0 || t.length > 40) return null;
  for (const [key, re] of Object.entries(SECTION_HEADINGS)) if (re.test(t)) return key;
  return null;
}

/** Verbos fracos/genéricos que costumam abrir bullets sem resultado. */
export const WEAK_PHRASES = [
  "responsável por",
  "responsavel por",
  "atuei em",
  "atuação em",
  "trabalhei com",
  "participei de",
  "auxílio em",
  "auxilio em",
  "ajudei",
  "responsible for",
  "worked on",
  "helped with",
  "participated in",
];

export const GENERIC_CLAIMS = [
  "proativo",
  "proativa",
  "dinâmico",
  "dinamica",
  "dinâmica",
  "comunicativo",
  "comunicativa",
  "trabalho em equipe",
  "hard worker",
  "team player",
  "self-motivated",
  "resultados",
];

/** Linhas com números/percentuais/moeda — sinal de resultado mensurável. */
export function hasMetric(line: string): boolean {
  return /(\d+\s?%|R\$\s?\d|US\$\s?\d|\$\d|\b\d{2,}\b\s?(clientes|usuários|usuarios|pessoas|projetos|leads|vendas|users|customers|projects|x\b))/i.test(line);
}

/** Palavras de senioridade/cargo para contextualizar a análise. */
export function guessSeniority(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(estagi[áa]rio|estágio|intern|trainee)\b/.test(t)) return "estágio/júnior";
  if (/\b(j[úu]nior|junior|jr\.?)\b/.test(t)) return "júnior";
  if (/\b(pleno|mid-level|mid level)\b/.test(t)) return "pleno";
  if (/\b(s[êe]nior|senior|sr\.?)\b/.test(t)) return "sênior";
  if (/\b(lead|líder|lider|head|gerente|manager|coordenador|coordenadora|diretor|diretora|cto|ceo|principal|staff)\b/.test(t)) return "liderança";
  return null;
}

export function guessCountry(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(brasil|brazil|são paulo|sao paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|recife|fortaleza|salvador|brasília|brasilia|cep\s?\d)\b/.test(t)) return "Brasil";
  if (/\b(portugal|lisboa|porto|coimbra|braga)\b/.test(t)) return "Portugal";
  if (/\b(united states|usa|new york|california|texas)\b/.test(t)) return "Estados Unidos";
  return null;
}

/** Título/profissão: primeira linha curta abaixo do nome, ou o cargo mais recente. */
export function guessProfession(lines: string[], experiencesRoles: string[]): string | null {
  const candidate = lines.slice(1, 6).find((l) => l.length > 3 && l.length < 60 && !/@|\+\d|\d{4}/.test(l) && !detectSection(l));
  return candidate ?? experiencesRoles[0] ?? null;
}
