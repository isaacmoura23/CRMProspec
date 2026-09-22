import "server-only";
import { safeFetch } from "@/services/career/safe-fetch";
import type { LinkCheck, LinkKind } from "@/types/career";

/**
 * Inspeção dos links do currículo.
 *
 * "Analisar tudo" aqui significa: visitar cada link público com orçamento
 * fixo (bytes, tempo, no GitHub até 5 repositórios e 3 READMEs) e registrar
 * exatamente o que foi lido, o que não foi e por quê. Login, CAPTCHA e
 * bloqueios são reportados como tais — nunca contornados nem simulados.
 */

const README_BUDGET_BYTES = 20_000;
const MAX_REPOS = 5;
const MAX_READMES = 3;

export function classifyLink(url: string): LinkKind {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host.endsWith("linkedin.com")) return "linkedin";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host.endsWith("gitlab.com")) return "gitlab";
  if (/credly|coursera|udemy|alura|certificate|certificado|badge|credential/i.test(url)) return "certificado";
  if (/behance|dribbble|github\.io|vercel\.app|netlify\.app|portfolio|portfolio/i.test(url)) return "portfolio";
  return "outro";
}

export type InspectionResult = Pick<
  LinkCheck,
  "final_url" | "status" | "http_status" | "content_summary" | "evidence" | "limitations" | "suggestions" | "consistent_with_resume"
>;

function textOf(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m?.[1]?.replace(/\s+/g, " ").trim() || null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function mentions(text: string, terms: string[]): string[] {
  const t = text.toLowerCase();
  return terms.filter((term) => term.length > 2 && t.includes(term.toLowerCase()));
}

interface ResumeContext {
  fullName: string;
  skills: string[];
}

async function inspectGithub(url: string, ctx: ResumeContext): Promise<InspectionResult> {
  const path = new URL(url).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const api = (p: string) => safeFetch(`https://api.github.com${p}`, { headers, maxBytes: 200_000 });

  const evidence: string[] = [];
  const limitations: string[] = [];
  const suggestions: string[] = [];

  if (path.length === 0) return { final_url: url, status: "quebrado", http_status: null, content_summary: null, evidence, limitations: ["URL do GitHub sem usuário"], suggestions, consistent_with_resume: null };

  const [user, repoName] = path;
  const repos: Array<{ name: string; description: string | null; language: string | null; stargazers_count: number; pushed_at: string; fork: boolean; full_name: string }> = [];

  if (repoName) {
    const r = await api(`/repos/${user}/${repoName}`);
    if (r.status === 404) return { final_url: url, status: "quebrado", http_status: 404, content_summary: null, evidence, limitations: ["Repositório não encontrado ou privado"], suggestions, consistent_with_resume: null };
    if (r.status === 403 || r.status === 429) return { final_url: url, status: "bloqueado", http_status: r.status, content_summary: null, evidence, limitations: ["Limite da API do GitHub atingido — defina GITHUB_TOKEN para ampliar a cota"], suggestions, consistent_with_resume: null };
    if (!r.ok) return { final_url: url, status: "quebrado", http_status: r.status, content_summary: null, evidence, limitations: [r.error ?? "Falha ao consultar"], suggestions, consistent_with_resume: null };
    repos.push(JSON.parse(r.body));
  } else {
    const u = await api(`/users/${user}`);
    if (u.status === 404) return { final_url: url, status: "quebrado", http_status: 404, content_summary: null, evidence, limitations: ["Usuário do GitHub não encontrado"], suggestions, consistent_with_resume: null };
    if (u.status === 403 || u.status === 429) return { final_url: url, status: "bloqueado", http_status: u.status, content_summary: null, evidence, limitations: ["Limite da API do GitHub atingido — defina GITHUB_TOKEN para ampliar a cota"], suggestions, consistent_with_resume: null };
    if (!u.ok) return { final_url: url, status: "quebrado", http_status: u.status, content_summary: null, evidence, limitations: [u.error ?? "Falha ao consultar"], suggestions, consistent_with_resume: null };
    const profile = JSON.parse(u.body) as { name: string | null; bio: string | null; public_repos: number; followers: number; blog: string | null; updated_at: string };
    evidence.push(`Perfil: ${profile.name ?? user} · ${profile.public_repos} repositórios públicos · ${profile.followers} seguidores`);
    if (!profile.bio) suggestions.push("Adicione uma bio ao perfil do GitHub com sua área e stack principal.");
    if (profile.name && ctx.fullName && !profile.name.toLowerCase().includes(ctx.fullName.split(" ")[0]!.toLowerCase())) {
      limitations.push(`O nome no GitHub ("${profile.name}") difere do currículo.`);
    }
    const list = await api(`/users/${user}/repos?sort=pushed&per_page=${MAX_REPOS}&type=owner`);
    if (list.ok) repos.push(...(JSON.parse(list.body) as typeof repos));
    else limitations.push("Lista de repositórios indisponível");
  }

  let readmes = 0;
  const languages = new Set<string>();
  for (const repo of repos) {
    if (repo.language) languages.add(repo.language);
    const age = Math.round((Date.now() - Date.parse(repo.pushed_at)) / 86_400_000);
    evidence.push(`${repo.full_name}: ${repo.description ?? "sem descrição"} · ${repo.language ?? "linguagem n/d"} · ${repo.stargazers_count}★ · último push há ${age} dias${repo.fork ? " · fork" : ""}`);
    if (!repo.description) suggestions.push(`Descreva o repositório ${repo.name} (uma frase sobre o que ele faz).`);
    if (readmes < MAX_READMES) {
      readmes += 1;
      const rd = await api(`/repos/${repo.full_name}/readme`);
      if (rd.ok) {
        const data = JSON.parse(rd.body) as { content?: string; encoding?: string };
        const text = data.content && data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf-8").slice(0, README_BUDGET_BYTES) : "";
        const hasRun = /(como (rodar|executar|instalar)|getting started|installation|how to run|npm (install|run)|docker)/i.test(text);
        const hasDemo = /(demo|preview|screenshot|deploy|https?:\/\/)/i.test(text);
        evidence.push(`README de ${repo.name}: ${text.length} caracteres lidos${hasRun ? ", com instruções de execução" : ""}${hasDemo ? ", com demo/links" : ""}`);
        if (!hasRun) suggestions.push(`README de ${repo.name}: inclua como instalar/rodar o projeto.`);
        if (!hasDemo) suggestions.push(`README de ${repo.name}: inclua capturas de tela ou link de demonstração.`);
      } else if (rd.status === 404) {
        suggestions.push(`Repositório ${repo.name} sem README — recrutadores não vão abrir o código para entender o projeto.`);
      }
    }
  }
  if (repos.length >= MAX_REPOS) limitations.push(`Analisados os ${MAX_REPOS} repositórios com atividade mais recente; os demais não foram lidos.`);
  if (repos.length > MAX_READMES) limitations.push(`READMEs lidos: ${Math.min(readmes, MAX_READMES)} de ${repos.length}.`);
  limitations.push("Código-fonte não foi executado nem auditado; apenas metadados e README.");

  const matched = mentions([...languages].join(" "), ctx.skills);
  const consistent = languages.size === 0 ? null : matched.length > 0;
  if (consistent === false) limitations.push(`As linguagens dos repositórios (${[...languages].join(", ")}) não aparecem nas competências do currículo.`);

  return {
    final_url: url,
    status: repos.length === 0 ? "parcial" : "concluido",
    http_status: 200,
    content_summary: repos.length ? `${repos.length} repositório(s) inspecionado(s); linguagens: ${[...languages].join(", ") || "n/d"}` : "Perfil consultado, sem repositórios públicos",
    evidence,
    limitations,
    suggestions: [...new Set(suggestions)].slice(0, 8),
    consistent_with_resume: consistent,
  };
}

async function inspectLinkedin(url: string): Promise<InspectionResult> {
  const evidence: string[] = [];
  const suggestions: string[] = [];
  const path = new URL(url).pathname;
  const custom = /^\/in\/[a-z0-9-]+\/?$/i.test(path);
  if (/^\/in\//i.test(path)) {
    evidence.push(`Formato de URL de perfil válido (${path})`);
    if (/\/in\/[a-z-]+-[0-9a-f]{6,}/i.test(path)) suggestions.push("Personalize a URL pública do LinkedIn (sem o sufixo numérico) — fica mais legível no currículo.");
  } else if (!custom) {
    evidence.push("URL não aponta para um perfil (/in/…)");
  }
  const res = await safeFetch(url, { method: "HEAD", timeoutMs: 6_000 });
  const blocked = res.status === 999 || res.status === 403 || res.status === 429 || /authwall|login/i.test(res.finalUrl);
  return {
    final_url: res.finalUrl,
    status: blocked || res.status === null ? "bloqueado" : res.status === 404 ? "quebrado" : "parcial",
    http_status: res.status,
    content_summary: null,
    evidence,
    limitations: [
      "O LinkedIn exige login para exibir o perfil; o conteúdo não foi lido e não contornamos a autenticação.",
      "Para uma revisão do perfil, exporte-o em PDF (Perfil → Mais → Salvar como PDF) e anexe como material complementar.",
    ],
    suggestions,
    consistent_with_resume: null,
  };
}

async function inspectGeneric(url: string, kind: LinkKind, ctx: ResumeContext): Promise<InspectionResult> {
  const res = await safeFetch(url, { maxBytes: 600_000 });
  const evidence: string[] = [];
  const limitations: string[] = [];
  const suggestions: string[] = [];

  if (res.status === null) return { final_url: res.finalUrl, status: res.error?.includes("interno") || res.error?.includes("permitid") ? "bloqueado" : "quebrado", http_status: null, content_summary: null, evidence, limitations: [res.error ?? "Sem resposta"], suggestions, consistent_with_resume: null };
  if (res.status === 401 || res.status === 403 || res.status === 429) return { final_url: res.finalUrl, status: "bloqueado", http_status: res.status, content_summary: null, evidence, limitations: [`O site respondeu ${res.status}: acesso restrito ou proteção anti-robô. Não contornamos bloqueios.`], suggestions, consistent_with_resume: null };
  if (!res.ok) return { final_url: res.finalUrl, status: "quebrado", http_status: res.status, content_summary: null, evidence, limitations: [`HTTP ${res.status}`], suggestions: ["Remova ou corrija o link — links quebrados passam desleixo."], consistent_with_resume: null };

  if (res.finalUrl !== url) evidence.push(`Redirecionou para ${res.finalUrl}`);
  const type = res.contentType ?? "";
  if (type.includes("pdf")) {
    return { final_url: res.finalUrl, status: "parcial", http_status: res.status, content_summary: "Documento PDF acessível", evidence: [...evidence, "Conteúdo é um PDF; não foi interpretado"], limitations: ["PDFs externos não são lidos nesta inspeção"], suggestions, consistent_with_resume: null };
  }
  if (!type.includes("html") && !type.includes("json")) {
    return { final_url: res.finalUrl, status: "parcial", http_status: res.status, content_summary: `Conteúdo ${type || "desconhecido"}`, evidence, limitations: ["Tipo de conteúdo não interpretado"], suggestions, consistent_with_resume: null };
  }

  const html = res.body;
  const title = textOf(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = textOf(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ?? textOf(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const ogTitle = textOf(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).slice(0, 20_000);
  const linkCount = (html.match(/<a\s/gi) ?? []).length;

  if (title) evidence.push(`Título: ${decodeEntities(title)}`);
  if (ogTitle && ogTitle !== title) evidence.push(`og:title: ${decodeEntities(ogTitle)}`);
  if (description) evidence.push(`Descrição: ${decodeEntities(description).slice(0, 160)}`);
  evidence.push(`${text.length} caracteres de texto lidos · ${linkCount} links na página${res.truncated ? " · leitura truncada no limite de bytes" : ""}`);
  if (res.truncated) limitations.push("Página maior que o orçamento de leitura; só o início foi analisado.");
  if (text.length < 300) {
    limitations.push("Pouco texto no HTML inicial — provavelmente renderizado por JavaScript, que não é executado nesta inspeção.");
  }
  const nameHit = ctx.fullName ? mentions(text, [ctx.fullName, ctx.fullName.split(" ")[0]!]).length > 0 : false;
  const skillHits = mentions(text, ctx.skills);
  if (nameHit) evidence.push("A página menciona o nome do candidato");
  if (skillHits.length) evidence.push(`Competências do currículo encontradas na página: ${skillHits.slice(0, 8).join(", ")}`);
  if (!title) suggestions.push("A página não tem <title>; defina um título com seu nome e área.");
  if (!description) suggestions.push("Adicione uma meta description — é o que aparece em buscas e prévias de link.");
  if (kind === "portfolio" && !/projet|project|case|trabalho|portf/i.test(text)) suggestions.push("O portfólio não deixa claro onde estão os projetos; destaque-os na primeira dobra.");
  if (kind === "portfolio" && !/contato|contact|e-mail|email|linkedin/i.test(text)) suggestions.push("Inclua uma forma de contato visível no portfólio.");

  const consistent = text.length < 300 ? null : nameHit || skillHits.length > 0;
  if (consistent === false) limitations.push("Nem o nome nem as competências do currículo aparecem no texto lido — confira se o link é o correto.");

  return {
    final_url: res.finalUrl,
    status: text.length < 300 ? "parcial" : "concluido",
    http_status: res.status,
    content_summary: title ? decodeEntities(title).slice(0, 160) : "Página sem título",
    evidence,
    limitations,
    suggestions,
    consistent_with_resume: consistent,
  };
}

export async function inspectLink(url: string, kind: LinkKind, ctx: ResumeContext): Promise<InspectionResult> {
  try {
    if (kind === "github") return await inspectGithub(url, ctx);
    if (kind === "linkedin") return await inspectLinkedin(url);
    return await inspectGeneric(url, kind, ctx);
  } catch (err) {
    return {
      final_url: url,
      status: "quebrado",
      http_status: null,
      content_summary: null,
      evidence: [],
      limitations: [err instanceof Error ? err.message : "Falha inesperada na inspeção"],
      suggestions: [],
      consistent_with_resume: null,
    };
  }
}
