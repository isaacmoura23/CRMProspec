import {
  GENERIC_CLAIMS,
  WEAK_PHRASES,
  detectSection,
  extractEmails,
  extractPhones,
  guessCountry,
  guessProfession,
  guessSeniority,
  hasMetric,
  parseDateRange,
} from "@/lib/resume-text";
import type {
  CareerEducation,
  CareerExperience,
  CareerProfile,
  CareerProject,
  ResumeCriterion,
  ResumeIssue,
  ResumeLink,
  ResumePage,
  ResumeSuggestion,
  SuggestionPriority,
} from "@/types/career";

/**
 * Motor determinístico de extração e análise de currículo.
 *
 * Puro (sem I/O) e sempre disponível: é o que roda quando não há LLM e é a
 * base sobre a qual o LLM, quando configurado, acrescenta sugestões — que
 * ainda passam pelos filtros anti-invenção de `guardSuggestion`.
 *
 * Pesos publicados dos critérios (somam 100). Um critério não avaliado sai
 * da conta: a nota é a média ponderada só do que foi medido, e a lista
 * `not_evaluated` diz o que ficou de fora e por quê.
 */

export const CRITERIA: Array<{ key: string; label: string; weight: number }> = [
  { key: "contact", label: "Contato e identificação", weight: 10 },
  { key: "structure", label: "Estrutura e organização", weight: 15 },
  { key: "clarity", label: "Clareza e concisão", weight: 15 },
  { key: "impact", label: "Resultados e impacto", weight: 20 },
  { key: "dates", label: "Consistência de datas", weight: 10 },
  { key: "writing", label: "Ortografia e padronização", weight: 10 },
  { key: "ats", label: "Legibilidade para triagem (ATS)", weight: 15 },
  { key: "fit", label: "Adequação ao cargo declarado", weight: 5 },
];

export type ProfileDraft = Pick<
  CareerProfile,
  | "full_name"
  | "email"
  | "phone"
  | "location"
  | "headline"
  | "summary"
  | "experiences"
  | "education"
  | "skills"
  | "languages"
  | "certifications"
  | "projects"
  | "links"
>;

interface Line {
  text: string;
  page: number;
}

function linesOf(pages: ResumePage[]): Line[] {
  const out: Line[] = [];
  for (const p of pages) {
    for (const raw of p.text.split(/\r?\n/)) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (text) out.push({ text, page: p.page });
    }
  }
  return out;
}

function splitList(text: string): string[] {
  return text
    .split(/[,;•·|\/]|\s{2,}|\n/)
    .map((s) => s.trim().replace(/^[-–•]\s*/, ""))
    .filter((s) => s.length >= 2 && s.length <= 40);
}

const LANGUAGE_WORDS = /\b(portugu[êe]s|ingl[êe]s|espanhol|franc[êe]s|alem[ãa]o|italiano|japon[êe]s|mandarim|english|spanish|french|german|portuguese|italian|japanese|chinese)\b/i;

const KNOWN_SKILLS = [
  "javascript", "typescript", "react", "next.js", "nextjs", "node", "node.js", "python", "java", "kotlin", "swift", "c#", ".net",
  "php", "laravel", "ruby", "rails", "go", "golang", "rust", "sql", "postgresql", "postgres", "mysql", "mongodb", "redis",
  "docker", "kubernetes", "aws", "azure", "gcp", "terraform", "git", "ci/cd", "graphql", "rest", "html", "css", "tailwind",
  "figma", "photoshop", "illustrator", "excel", "power bi", "tableau", "sap", "salesforce", "hubspot", "google ads", "meta ads",
  "seo", "sem", "crm", "scrum", "kanban", "agile", "ágil", "jira", "linux", "flutter", "react native", "angular", "vue",
  "django", "flask", "spring", "pandas", "machine learning", "data science", "análise de dados", "vendas", "negociação",
  "atendimento ao cliente", "gestão de projetos", "gestão de pessoas", "marketing digital", "copywriting", "ux", "ui",
];

/**
 * Extração heurística do perfil. Não inventa: campos sem evidência ficam
 * nulos/vazios e o titular completa na revisão.
 */
export function extractProfileHeuristic(pages: ResumePage[], links: ResumeLink[]): ProfileDraft {
  const lines = linesOf(pages);
  const full = pages.map((p) => p.text).join("\n");
  const emails = extractEmails(full);
  const phones = extractPhones(full);

  // Nome: primeira linha curta sem @/dígitos, tipicamente no topo.
  const nameLine = lines.slice(0, 5).find((l) => l.text.length >= 4 && l.text.length <= 60 && !/[@\d]/.test(l.text) && !detectSection(l.text));
  const full_name = nameLine?.text ?? "";

  const sections: Record<string, Line[]> = {};
  let current = "header";
  for (const line of lines) {
    const sec = detectSection(line.text);
    if (sec) {
      current = sec;
      continue;
    }
    (sections[current] ??= []).push(line);
  }

  const header = sections.header ?? [];
  const location = header.find((l) => /\b([A-ZÁ-Ú][a-zá-ú]+(?: [A-ZÁ-Ú][a-zá-ú]+)*)\s*[-–,\/]\s*[A-Z]{2}\b/.test(l.text) || /\b(brasil|portugal|remoto|remote)\b/i.test(l.text))?.text ?? null;

  const experiences: CareerExperience[] = [];
  let currentExp: CareerExperience | null = null;
  for (const line of sections.experience ?? []) {
    const range = parseDateRange(line.text);
    if (range) {
      const title = line.text.replace(range.raw, "").replace(/[|•·\-–—,]+$/g, "").replace(/^[|•·\-–—,]+/g, "").trim();
      const [a, b] = title.split(/\s[|•·@–—-]\s|\s(?:na|no|at|em)\s/i);
      currentExp = { company: (b ?? "").trim(), role: (a ?? title).trim(), start: range.start, end: range.end, description: "", page: line.page };
      experiences.push(currentExp);
    } else if (currentExp) {
      // Linha logo após a data sem descrição ainda costuma ser empresa/cargo faltante.
      if (!currentExp.company && !currentExp.description && line.text.length < 60 && !/^[-–•]/.test(line.text)) {
        currentExp.company = line.text;
      } else {
        currentExp.description += (currentExp.description ? "\n" : "") + line.text;
      }
    }
  }

  const education: CareerEducation[] = [];
  let currentEdu: CareerEducation | null = null;
  for (const line of sections.education ?? []) {
    const range = parseDateRange(line.text);
    const title = range ? line.text.replace(range.raw, "").replace(/[|•·\-–—,]+$/g, "").trim() : line.text;
    if (range || !currentEdu || line.text.length < 80) {
      if (currentEdu && !range && !currentEdu.institution) {
        currentEdu.institution = title;
        continue;
      }
      currentEdu = { institution: "", degree: title, start: range?.start ?? null, end: range?.end ?? null, page: line.page };
      education.push(currentEdu);
    }
  }

  const skillsText = (sections.skills ?? []).map((l) => l.text).join("\n");
  const skills = new Set<string>(splitList(skillsText));
  const lowerFull = full.toLowerCase();
  for (const s of KNOWN_SKILLS) {
    const re = new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(lowerFull)) skills.add(s);
  }

  const languages = [
    ...new Set(
      (sections.languages ?? [])
        .map((l) => l.text)
        .concat(lines.filter((l) => LANGUAGE_WORDS.test(l.text) && l.text.length < 60).map((l) => l.text))
        .flatMap((t) => t.match(new RegExp(LANGUAGE_WORDS.source, "gi")) ?? [])
        .map((s) => s.toLowerCase())
    ),
  ];

  const certifications = (sections.certifications ?? []).map((l) => l.text).filter((t) => t.length > 3).slice(0, 20);

  const projects: CareerProject[] = (sections.projects ?? [])
    .filter((l) => l.text.length > 3 && l.text.length < 200)
    .slice(0, 10)
    .map((l) => ({
      name: l.text.split(/[:–—-]/)[0]!.trim().slice(0, 80),
      description: l.text,
      url: links.find((k) => k.page === l.page && /github|gitlab|vercel|netlify|\.app|\.dev/i.test(k.url))?.url ?? null,
      page: l.page,
    }));

  const summaryLines = (sections.summary ?? []).map((l) => l.text);
  const headline = guessProfession(lines.map((l) => l.text), experiences.map((e) => e.role));

  return {
    full_name,
    email: emails[0] ?? null,
    phone: phones[0] ?? null,
    location,
    headline,
    summary: summaryLines.length ? summaryLines.join(" ").slice(0, 800) : null,
    experiences,
    education,
    skills: [...skills].slice(0, 60),
    languages,
    certifications,
    projects,
    links: links.map((l) => l.url),
  };
}

/* ------------------------------------------------------------------ */
/* Análise                                                             */
/* ------------------------------------------------------------------ */

export interface EngineAnalysis {
  score: number | null;
  criteria: ResumeCriterion[];
  issues: ResumeIssue[];
  suggestions: ResumeSuggestion[];
  not_evaluated: string[];
  context: { profession: string | null; seniority: string | null; country: string | null };
}

let seq = 0;
function sid(prefix: string) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq}`;
}

function clamp(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function monthIndex(ym: string | null): number | null {
  if (!ym) return null;
  const [y, m] = ym.split("-").map(Number);
  if (!y) return null;
  return y * 12 + ((m ?? 6) - 1);
}

export function analyzeResumeHeuristic(
  pages: ResumePage[],
  links: ResumeLink[],
  profile: ProfileDraft,
  opts: { llmAvailable: boolean; layoutAvailable: boolean }
): EngineAnalysis {
  const lines = linesOf(pages);
  const full = pages.map((p) => p.text).join("\n");
  const issues: ResumeIssue[] = [];
  const suggestions: ResumeSuggestion[] = [];
  const not_evaluated: string[] = [];
  const criteria: ResumeCriterion[] = [];

  const profession = profile.headline;
  const seniority = guessSeniority(full);
  const country = guessCountry(full);
  const portfolioRelevant = /\b(design|desenvolv|developer|engenheir|engineer|front|back|full.?stack|ux|ui|dados|data|arquitet|fotograf|redator|copy|marketing|produto|product)\b/i.test(
    `${profession ?? ""} ${profile.skills.join(" ")}`
  );

  const push = (criterion: string, priority: SuggestionPriority, title: string, detail: string, page: number | null = null) =>
    issues.push({ id: sid("iss"), criterion, priority, title, detail, page });

  const suggest = (s: Omit<ResumeSuggestion, "id" | "status" | "edited">) =>
    suggestions.push({ id: sid("sug"), status: "pendente", edited: null, ...s });

  /* 1. Contato */
  {
    const ev: string[] = [];
    let score = 0;
    if (profile.full_name) { score += 25; ev.push(`Nome identificado: ${profile.full_name}`); } else push("contact", "alta", "Nome não identificado no topo", "O nome deveria ser a primeira linha do currículo, em destaque.", 1);
    if (profile.email) { score += 30; ev.push(`E-mail: ${profile.email}`); } else push("contact", "alta", "E-mail ausente", "Sem e-mail o recrutador não consegue responder.", 1);
    if (profile.phone) { score += 20; ev.push(`Telefone: ${profile.phone}`); } else push("contact", "media", "Telefone ausente", "Inclua um telefone com DDD (ou DDI, se aplicar a vagas fora do país).", 1);
    const professionalLink = links.find((l) => /linkedin\.com|github\.com|gitlab\.com|behance|dribbble/i.test(l.url));
    if (professionalLink) { score += 25; ev.push(`Link profissional: ${professionalLink.url} (p. ${professionalLink.page})`); }
    else if (portfolioRelevant) push("contact", "media", "Nenhum link profissional (LinkedIn/portfólio)", "Para a sua área, recrutadores costumam checar LinkedIn, GitHub ou portfólio.", 1);
    else { score += 15; ev.push("Sem link profissional — pouco relevante para a área detectada"); }
    criteria.push({ key: "contact", label: "Contato e identificação", weight: 10, score: clamp(score), evidence: ev, note: null });
  }

  /* 2. Estrutura */
  {
    const found = new Set(lines.map((l) => detectSection(l.text)).filter(Boolean) as string[]);
    const ev = [`Seções detectadas: ${found.size ? [...found].join(", ") : "nenhuma"}`, `Páginas: ${pages.length}`];
    let score = 0;
    for (const s of ["experience", "education", "skills"]) {
      if (found.has(s)) score += 22;
      else push("structure", "alta", `Seção de ${s === "experience" ? "experiência" : s === "education" ? "formação" : "habilidades"} não identificada`, "Use títulos de seção convencionais para que pessoas e sistemas encontrem o conteúdo.");
    }
    if (found.has("summary")) score += 14;
    else {
      push("structure", "media", "Sem resumo profissional", "Um resumo de 2–3 linhas no topo orienta a leitura.");
      const parts = [profession, seniority && `nível ${seniority}`, profile.skills.slice(0, 4).join(", ")].filter(Boolean);
      if (parts.length >= 2) {
        suggest({
          priority: "media",
          original: lines[1]?.text ?? "",
          problem: "O currículo abre sem um resumo que diga quem você é e o que busca.",
          rationale: "Um resumo curto com cargo, senioridade e principais competências reduz o tempo de triagem.",
          suggested: `${profession ?? "Profissional"}${seniority ? ` (${seniority})` : ""} com experiência em ${profile.skills.slice(0, 4).join(", ")}. [Complete com o objetivo/área de interesse.]`,
          page: 1,
          needs_user_input: true,
        });
      }
    }
    if (pages.length <= 3) score += 20;
    else push("structure", "media", `Currículo com ${pages.length} páginas`, "Acima de 3 páginas a leitura cai; priorize as experiências recentes e relevantes.");
    criteria.push({ key: "structure", label: "Estrutura e organização", weight: 15, score: clamp(score), evidence: ev, note: null });
  }

  /* 3. Clareza */
  {
    const longLines = lines.filter((l) => l.text.length > 280);
    const bullets = lines.filter((l) => /^[-–•·▪●]/.test(l.text) || l.text.length < 200);
    const score = 100 - longLines.length * 12;
    const ev = [`${longLines.length} trecho(s) acima de 280 caracteres`, `${bullets.length} linhas curtas/bullets`];
    for (const l of longLines.slice(0, 4)) {
      suggest({
        priority: "media",
        original: l.text,
        problem: "Parágrafo longo demais para leitura rápida.",
        rationale: "Recrutadores gastam segundos por currículo; bullets de uma linha são lidos, parágrafos são pulados.",
        suggested: l.text
          .split(/(?<=[.;])\s+/)
          .filter(Boolean)
          .map((s) => `• ${s.trim()}`)
          .join("\n"),
        page: l.page,
        needs_user_input: false,
      });
    }
    criteria.push({ key: "clarity", label: "Clareza e concisão", weight: 15, score: clamp(score), evidence: ev, note: null });
  }

  /* 4. Impacto */
  {
    const expLines = lines.filter((l) => l.text.length > 25 && l.text.length < 400);
    const withMetric = expLines.filter((l) => hasMetric(l.text));
    const weak = expLines.filter((l) => WEAK_PHRASES.some((w) => l.text.toLowerCase().includes(w)));
    const generic = lines.filter((l) => GENERIC_CLAIMS.some((g) => new RegExp(`\\b${g}\\b`, "i").test(l.text)) && l.text.length < 120);
    const ratio = expLines.length ? withMetric.length / expLines.length : 0;
    const score = 30 + ratio * 70 - weak.length * 6 - generic.length * 4;
    const ev = [
      `${withMetric.length} de ${expLines.length} linhas com números/resultados`,
      ...(weak.length ? [`${weak.length} linha(s) iniciando com expressões genéricas (ex.: "${weak[0]!.text.slice(0, 40)}…", p. ${weak[0]!.page})`] : []),
    ];
    if (ratio < 0.2) push("impact", "alta", "Poucos resultados mensuráveis", "Descreva o que mudou com o seu trabalho (volume, prazo, %, receita). Sem número real, descreva o efeito concreto — não invente métricas.");
    for (const l of weak.slice(0, 5)) {
      suggest({
        priority: "alta",
        original: l.text,
        problem: "Começa com expressão genérica que não diz o que você fez nem o resultado.",
        rationale: "Frases como “responsável por” escondem a ação. Verbo de ação + o que fez + efeito é o que a triagem procura.",
        suggested: `[Verbo de ação — ex.: Implementei / Reduzi / Liderei] ${l.text.replace(new RegExp(WEAK_PHRASES.join("|"), "i"), "").trim()} [+ resultado concreto, se houver dado real]`,
        page: l.page,
        needs_user_input: true,
      });
    }
    for (const l of generic.slice(0, 3)) {
      suggest({
        priority: "baixa",
        original: l.text,
        problem: "Autodescrição genérica sem evidência.",
        rationale: "Adjetivos como “proativo” são ignorados na triagem; uma situação concreta em que isso apareceu convence mais.",
        suggested: "[Substitua por um fato: situação + ação sua + consequência observável.]",
        page: l.page,
        needs_user_input: true,
      });
    }
    criteria.push({ key: "impact", label: "Resultados e impacto", weight: 20, score: clamp(score), evidence: ev, note: null });
  }

  /* 5. Datas */
  {
    const ranges = profile.experiences.map((e) => ({ e, s: monthIndex(e.start), en: e.end ? monthIndex(e.end) : null }));
    const ev: string[] = [`${profile.experiences.length} experiência(s) com período identificado`];
    let score = profile.experiences.length ? 100 : 60;
    if (!profile.experiences.length) ev.push("Nenhum intervalo de datas reconhecido nas experiências");
    for (const r of ranges) {
      if (r.s !== null && r.en !== null && r.en < r.s) {
        score -= 30;
        push("dates", "alta", `Data final anterior à inicial em "${r.e.role || r.e.company}"`, `${r.e.start} → ${r.e.end}`, r.e.page);
      }
    }
    const sorted = ranges.filter((r) => r.s !== null).sort((a, b) => a.s! - b.s!);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1]!.en ?? monthIndex(new Date().toISOString().slice(0, 7))!;
      const gap = sorted[i]!.s! - prevEnd;
      if (gap > 12) {
        score -= 10;
        push("dates", "media", `Intervalo de ${Math.round(gap / 12)} ano(s) sem experiência listada`, `Entre "${sorted[i - 1]!.e.role}" e "${sorted[i]!.e.role}". Se houve estudo, projeto ou pausa, vale explicitar.`, sorted[i]!.e.page);
      }
    }
    const current = ranges.filter((r) => r.en === null && r.e.start).length;
    if (current > 2) { score -= 15; push("dates", "media", `${current} experiências marcadas como atuais`, "Confira se todas continuam em andamento."); }
    criteria.push({ key: "dates", label: "Consistência de datas", weight: 10, score: clamp(score), evidence: ev, note: null });
  }

  /* 6. Ortografia e padronização (heurístico; o LLM complementa quando disponível) */
  {
    const caps = lines.filter((l) => l.text.length > 12 && l.text === l.text.toUpperCase() && /[A-ZÁ-Ú]{4,}/.test(l.text));
    const doublePunct = lines.filter((l) => /[!?.]{2,}|\s[,.;]/.test(l.text));
    const mixedBullets = new Set(lines.map((l) => /^([-–•·▪●])/.exec(l.text)?.[1]).filter(Boolean)).size;
    const score = 100 - caps.length * 5 - doublePunct.length * 5 - (mixedBullets > 1 ? 10 : 0);
    const ev = [`${caps.length} linha(s) em caixa alta`, `${doublePunct.length} linha(s) com pontuação irregular`, `${mixedBullets} estilo(s) de marcador`];
    if (caps.length > 3) push("writing", "baixa", "Uso excessivo de caixa alta", "Reserve maiúsculas para títulos de seção.", caps[0]!.page);
    if (mixedBullets > 1) push("writing", "baixa", "Marcadores de lista inconsistentes", "Use um único símbolo de bullet em todo o documento.");
    criteria.push({
      key: "writing",
      label: "Ortografia e padronização",
      weight: 10,
      score: clamp(score),
      evidence: ev,
      note: opts.llmAvailable ? null : "Sem modelo de linguagem configurado, a ortografia foi avaliada só por padrões de formatação.",
    });
  }

  /* 7. ATS */
  {
    const chars = full.length;
    const perPage = chars / Math.max(1, pages.length);
    const shortRuns = lines.filter((l) => l.text.length < 12).length / Math.max(1, lines.length);
    const ev = [`${Math.round(perPage)} caracteres extraíveis por página`, `${Math.round(shortRuns * 100)}% de linhas muito curtas (indício de colunas/tabelas)`];
    let score = 100;
    if (perPage < 800) { score -= 40; push("ats", "alta", "Pouco texto extraível", "Sistemas de triagem leem o texto do PDF; conteúdo em imagem ou caixas gráficas some. Exporte o PDF a partir de texto, não de imagem.", 1); }
    if (shortRuns > 0.35) { score -= 25; push("ats", "media", "Layout provável em colunas/tabelas", "A ordem de leitura de colunas costuma se embaralhar nos ATS. Prefira uma coluna.", 1); }
    const sectionsFound = lines.filter((l) => detectSection(l.text)).length;
    if (sectionsFound < 2) score -= 20;
    criteria.push({ key: "ats", label: "Legibilidade para triagem (ATS)", weight: 15, score: clamp(score), evidence: ev, note: null });
  }

  /* 8. Adequação ao cargo declarado */
  {
    if (!profession) {
      criteria.push({ key: "fit", label: "Adequação ao cargo declarado", weight: 5, score: null, evidence: [], note: "Nenhum cargo/objetivo declarado foi identificado." });
      not_evaluated.push("Adequação ao cargo declarado: não há cargo ou objetivo identificável no currículo.");
    } else {
      const tokens = profession.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      const hits = tokens.filter((t) => profile.skills.some((s) => s.toLowerCase().includes(t)) || profile.experiences.some((e) => e.description.toLowerCase().includes(t)));
      const score = tokens.length ? 40 + (hits.length / tokens.length) * 60 : 60;
      criteria.push({ key: "fit", label: "Adequação ao cargo declarado", weight: 5, score: clamp(score), evidence: [`Cargo declarado: ${profession}`, `${hits.length}/${tokens.length} termos do cargo aparecem em habilidades/experiências`], note: null });
    }
  }

  if (!opts.layoutAvailable) {
    not_evaluated.push("Layout visual (alinhamento, fontes, espaçamento): requer renderização das páginas, não configurada neste ambiente.");
  }
  not_evaluated.push("Veracidade das informações: não é verificável a partir do documento.");

  const evaluated = criteria.filter((c) => c.score !== null);
  const totalWeight = evaluated.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight ? clamp(evaluated.reduce((s, c) => s + c.score! * c.weight, 0) / totalWeight) : null;

  return { score, criteria, issues, suggestions, not_evaluated, context: { profession, seniority, country } };
}

/* ------------------------------------------------------------------ */
/* Filtros anti-invenção para sugestões vindas do LLM                  */
/* ------------------------------------------------------------------ */

function numbersIn(s: string): Set<string> {
  return new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
}

/**
 * Uma sugestão só entra se o trecho original existir de fato no currículo
 * e se o texto sugerido não introduzir números que não estavam nem no
 * original nem no documento — é a forma mecânica de barrar métricas
 * inventadas. Sugestões que dependem de dado do titular ficam marcadas.
 */
export function guardSuggestion(
  s: { original: string; suggested: string; problem: string; rationale: string; priority: string; page?: number | null; needs_user_input?: boolean },
  fullText: string
): ResumeSuggestion | null {
  const original = s.original.trim();
  if (original.length < 8) return null;
  const normalized = fullText.replace(/\s+/g, " ");
  if (!normalized.includes(original.replace(/\s+/g, " "))) return null;
  const allowed = new Set([...numbersIn(original), ...numbersIn(fullText)]);
  for (const n of numbersIn(s.suggested)) if (!allowed.has(n)) return null;
  const priority: SuggestionPriority = s.priority === "alta" || s.priority === "baixa" ? s.priority : "media";
  return {
    id: sid("sug"),
    priority,
    original,
    problem: s.problem.trim(),
    rationale: s.rationale.trim(),
    suggested: s.suggested.trim(),
    page: s.page ?? null,
    needs_user_input: Boolean(s.needs_user_input) || /\[[^\]]+\]/.test(s.suggested),
    status: "pendente",
    edited: null,
  };
}

/** Localiza a página em que um trecho aparece. */
export function pageOf(pages: ResumePage[], snippet: string): number | null {
  const s = snippet.replace(/\s+/g, " ").trim();
  for (const p of pages) if (p.text.replace(/\s+/g, " ").includes(s)) return p.page;
  return null;
}
