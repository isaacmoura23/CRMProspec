import { extractRequirements } from "@/lib/job-text";
import type { CareerPreferences, CareerProfile, JobMatch, JobPosting } from "@/types/career";

/**
 * Aderência explicável entre perfil confirmado e vaga.
 *
 * Saída: requisitos atendidos, lacunas, fatores desconhecidos e restrições
 * obrigatórias (que zeram a nota). Requisitos desejáveis pesam menos que
 * obrigatórios. Nada aqui usa atributos pessoais sensíveis: só
 * competências, experiência, idioma, localização e modalidade.
 */

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+#. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["com", "de", "em", "para", "and", "the", "with", "or", "ou", "e", "a", "o", "in", "of", "to", "experiencia", "experience", "conhecimento", "knowledge", "anos", "years", "nivel", "level", "desejavel", "obrigatorio", "required"]);

function terms(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function profileCorpus(profile: CareerProfile): string {
  return norm(
    [
      profile.headline,
      profile.summary,
      ...profile.skills,
      ...profile.languages,
      ...profile.certifications,
      ...profile.experiences.map((e) => `${e.role} ${e.description}`),
      ...profile.projects.map((p) => `${p.name} ${p.description}`),
      ...profile.education.map((e) => `${e.degree} ${e.institution}`),
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/** Um requisito é atendido se seus termos "fortes" (≥ 3 letras) aparecem no perfil. */
function requirementMet(req: string, corpus: string, skills: Set<string>): "met" | "gap" | "unknown" {
  const ts = terms(req).filter((t) => t.length >= 3);
  if (ts.length === 0) return "unknown";
  const hits = ts.filter((t) => skills.has(t) || corpus.includes(` ${t} `) || corpus.startsWith(`${t} `) || corpus.endsWith(` ${t}`));
  const ratio = hits.length / ts.length;
  if (ratio >= 0.5) return "met";
  // Requisitos "soft" (comunicação, proatividade) não são verificáveis pelo currículo.
  if (/comunica|proativ|equipe|team|organiza|dinamic|colabora/i.test(req)) return "unknown";
  return "gap";
}

function yearsOfExperience(profile: CareerProfile): number | null {
  const months = profile.experiences.reduce((acc, e) => {
    if (!e.start) return acc;
    const [sy, sm] = e.start.split("-").map(Number);
    const end = e.end ? e.end.split("-").map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
    const start = sy! * 12 + (sm ?? 6);
    const fin = end[0]! * 12 + (end[1] ?? 6);
    return acc + Math.max(0, fin - start);
  }, 0);
  return profile.experiences.some((e) => e.start) ? Math.round(months / 12) : null;
}

export function computeMatch(
  profile: CareerProfile,
  prefs: CareerPreferences | null,
  job: JobPosting
): Omit<JobMatch, "id" | "owner_id" | "organization_id" | "job_id" | "profile_id" | "saved" | "dismissed" | "computed_at"> {
  const corpus = ` ${profileCorpus(profile)} `;
  const skills = new Set(profile.skills.flatMap((s) => [norm(s), ...terms(s)]));
  const met: string[] = [];
  const gaps: string[] = [];
  const unknown: string[] = [];
  const blocked_by: string[] = [];

  const { required, desirable } = extractRequirements(job.description);
  const requiredList = required.length ? required : job.requirements;

  let reqScore = 0;
  let reqTotal = 0;
  for (const r of requiredList) {
    const verdict = requirementMet(r, corpus, skills);
    reqTotal += 1;
    if (verdict === "met") { met.push(r); reqScore += 1; }
    else if (verdict === "gap") gaps.push(r);
    else { unknown.push(r); reqScore += 0.5; }
  }
  let desScore = 0;
  for (const d of desirable) {
    const verdict = requirementMet(d, corpus, skills);
    if (verdict === "met") { met.push(`(desejável) ${d}`); desScore += 1; }
    else if (verdict === "gap") gaps.push(`(desejável) ${d}`);
  }

  // Sem lista de requisitos, compara o vocabulário da descrição com o perfil.
  let vocabScore: number | null = null;
  if (reqTotal === 0) {
    const vocab = [...new Set(terms(job.description).filter((t) => t.length >= 4))].slice(0, 200);
    const hits = vocab.filter((t) => skills.has(t) || corpus.includes(` ${t} `));
    vocabScore = vocab.length ? hits.length / vocab.length : 0;
    if (hits.length) met.push(`Termos em comum com o anúncio: ${hits.slice(0, 8).join(", ")}`);
    unknown.push("O anúncio não lista requisitos de forma estruturada; a comparação usou o vocabulário da descrição.");
  }

  // Título × cargos desejados / headline
  const titleTerms = terms(job.title);
  const desired = [...(prefs?.desired_roles ?? []), profile.headline ?? ""].flatMap(terms);
  const titleHits = titleTerms.filter((t) => desired.includes(t));
  const titleScore = titleTerms.length ? titleHits.length / titleTerms.length : 0;
  if (titleHits.length) met.push(`Cargo compatível com o perfil/preferências (${titleHits.join(", ")})`);
  else if (desired.length) gaps.push(`O título "${job.title}" não bate com os cargos desejados`);

  // Senioridade declarada na vaga × anos de experiência
  const years = yearsOfExperience(profile);
  const minYears = /(\d+)\+?\s*(anos|years)/i.exec(job.description)?.[1];
  if (minYears && years !== null) {
    if (years >= Number(minYears)) met.push(`${years} ano(s) de experiência ≥ ${minYears} exigidos`);
    else gaps.push(`A vaga pede ${minYears}+ anos; o currículo soma ~${years}`);
  } else if (minYears) unknown.push(`A vaga pede ${minYears}+ anos; não foi possível somar a experiência do currículo`);

  // Restrições obrigatórias (preferências do titular)
  if (prefs) {
    if (prefs.excluded_companies.some((c) => norm(c) && norm(job.company).includes(norm(c)))) blocked_by.push(`Empresa excluída nas preferências (${job.company})`);
    if (prefs.work_modes.length && job.work_mode && !prefs.work_modes.includes(job.work_mode)) blocked_by.push(`Modalidade ${job.work_mode} fora das preferidas (${prefs.work_modes.join(", ")})`);
    if (prefs.locations.length && job.work_mode !== "remoto" && job.location) {
      const ok = prefs.locations.some((l) => norm(job.location!).includes(norm(l)) || norm(l).includes(norm(job.location!)));
      if (!ok) blocked_by.push(`Local ${job.location} fora das localizações preferidas`);
    }
    if (prefs.languages.length && job.language && job.language !== "pt" && !prefs.languages.some((l) => norm(l).startsWith(job.language === "en" ? "ingl" : job.language === "es" ? "espa" : "port") || norm(l).startsWith(job.language === "en" ? "engl" : "xx"))) {
      unknown.push(`Anúncio em ${job.language === "en" ? "inglês" : "espanhol"}; o idioma não consta nas preferências`);
    }
  }
  if (job.status === "encerrada") blocked_by.push("Anúncio encerrado");

  const reqPart = reqTotal ? reqScore / reqTotal : vocabScore ?? 0.5;
  const desPart = desirable.length ? desScore / desirable.length : 0.5;
  const recency = job.posted_at ? Math.max(0, 1 - (Date.now() - Date.parse(job.posted_at)) / (45 * 86_400_000)) : 0.5;
  let score = Math.round(reqPart * 55 + titleScore * 25 + desPart * 10 + recency * 10);
  if (blocked_by.length) score = 0;
  score = Math.max(0, Math.min(100, score));

  const explanation = blocked_by.length
    ? `Bloqueada: ${blocked_by.join("; ")}.`
    : `${met.length} correspondência(s), ${gaps.length} lacuna(s), ${unknown.length} fator(es) não verificável(is). Requisitos obrigatórios: ${reqTotal ? `${Math.round(reqPart * 100)}%` : "não listados"}; título: ${Math.round(titleScore * 100)}%.`;

  return { score, met: met.slice(0, 20), gaps: gaps.slice(0, 20), unknown: unknown.slice(0, 10), blocked_by, explanation };
}
