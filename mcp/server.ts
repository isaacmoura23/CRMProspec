/**
 * Servidor MCP do ProspecAtlas — ferramentas de desenvolvimento.
 *
 * Cada ferramenta aqui nasceu de algo que foi feito à mão, com script
 * descartável, durante o desenvolvimento: medir quantas empresas da fonte
 * têm site, descobrir que o mesmo e-mail de uma agência constava como
 * contato de sete imobiliárias, conferir se as análises saíam idênticas,
 * olhar a fila do módulo Carreira. Em vez de reescrever esses scripts a
 * cada sessão, eles viram ferramentas.
 *
 * O servidor roda sobre o código real do app (não uma cópia), lendo o banco
 * local `.data/db.json` e chamando os mesmos provedores e serviços que a
 * aplicação usa. É um servidor local, por stdio, para uso em
 * desenvolvimento — não é uma API de produção.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getDb } from "@/lib/store";
import { engineAnalyze } from "@/ai/engine";
import { isLlmConfigured } from "@/ai/client";
import { GooglePlacesProvider } from "@/providers/google-places-provider";
import { getActiveProvider } from "@/providers/registry";
import { pickEmail } from "@/services/enrichment";
import { FILTER_LABEL, filterWarnings, rejectionReasons } from "@/services/lead-filter";
import { createProspectingJob } from "@/jobs/prospecting";
import { getCareerData } from "@/services/career/repository";
import { visibleLeads } from "@/services/lead-visibility";
import type { Lead, ProspectingJob, SearchParams } from "@/types";

const servidor = new McpServer({ name: "prospecatlas-dev", version: "1.0.0" });

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function texto(conteudo: string) {
  return { content: [{ type: "text" as const, text: conteudo }] };
}

function tabela(linhas: string[][]): string {
  if (linhas.length === 0) return "(vazio)";
  const larguras = linhas[0]!.map((_, i) => Math.max(...linhas.map((l) => (l[i] ?? "").length)));
  return linhas.map((l) => l.map((c, i) => (c ?? "").padEnd(larguras[i]!)).join("  ")).join("\n");
}

/**
 * Provedores públicos: a empresa usando Gmail/Hotmail é contato legítimo —
 * é a mesma regra de `pickEmail`. Sem isto a auditoria acusa esses casos e
 * esconde o que importa, que é e-mail de outro domínio corporativo (o
 * fornecedor que fez o site).
 */
const PROVEDORES_PUBLICOS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br",
  "live.com", "msn.com", "yahoo.com", "yahoo.com.br", "icloud.com", "me.com", "uol.com.br",
  "bol.com.br", "terra.com.br", "ig.com.br", "globo.com", "sapo.pt", "clix.pt",
]);

function dominioDe(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Resumo de uma linha por lead, no formato que costuma ser inspecionado. */
function linhaLead(l: Lead): string[] {
  return [
    String(l.lead_score ?? "—"),
    l.company_name.slice(0, 38),
    l.segment.slice(0, 16),
    l.city.slice(0, 16),
    l.website ? "site" : "—",
    l.instagram ? "ig" : "—",
    l.whatsapp ? "wpp" : l.phone ? "tel" : "—",
    l.email ? "email" : "—",
    l.source,
  ];
}

const FILTROS_SCHEMA = {
  hasPhone: z.boolean().optional(),
  hasWhatsapp: z.boolean().optional(),
  hasInstagram: z.boolean().optional(),
  hasEmail: z.boolean().optional(),
  noWebsite: z.boolean().optional(),
  hasWebsite: z.boolean().optional(),
  badWebsite: z.boolean().optional(),
  activeBusiness: z.boolean().optional(),
  hasReviews: z.boolean().optional(),
  strongSocial: z.boolean().optional(),
};

/* ------------------------------------------------------------------ */
/* 1. Panorama                                                         */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "crm_panorama",
  {
    title: "Panorama do CRM",
    description:
      "Visão geral do banco local: leads por fonte/nicho/cidade, usuários e papéis, últimas prospecções e o que está configurado no ambiente (sem revelar valores de chaves). É o primeiro lugar para olhar antes de investigar qualquer coisa.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const db = getDb();
    const porFonte = new Map<string, number>();
    const porNicho = new Map<string, number>();
    const porCidade = new Map<string, number>();
    for (const l of db.leads) {
      porFonte.set(l.source, (porFonte.get(l.source) ?? 0) + 1);
      porNicho.set(l.segment, (porNicho.get(l.segment) ?? 0) + 1);
      porCidade.set(l.city, (porCidade.get(l.city) ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(", ");

    const demo = db.leads.filter((l) => l.source === "demo");
    const reais = db.leads.filter((l) => l.source !== "demo");
    const media = (ls: Lead[]) => (ls.length ? Math.round(ls.reduce((s, l) => s + (l.lead_score ?? 0), 0) / ls.length) : 0);

    const jobs = [...db.prospecting_jobs]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((j) => [
        j.created_at.slice(0, 16),
        `${j.params.niche}/${j.params.city}`.slice(0, 28),
        `pediu ${j.params.quantity}`,
        `achou ${j.found_lead_ids.length}`,
        `filtrou ${j.filtered ?? 0}`,
        j.status,
      ]);

    const carreira = getCareerData();
    const ambiente = [
      ["Google Places", process.env.GOOGLE_PLACES_API_KEY ? "configurado" : "ausente"],
      ["OpenAI (análise por LLM)", isLlmConfigured() ? "configurado" : "ausente — motor determinístico"],
      ["Supabase (banco/auth)", process.env.NEXT_PUBLIC_SUPABASE_URL ? "configurado" : "ausente — modo demo"],
      ["Resend (candidaturas)", process.env.RESEND_API_KEY ? "configurado" : "ausente"],
      ["OCR", process.env.OCR_SPACE_API_KEY ? "configurado" : "ausente"],
      ["Worker (cron)", process.env.CRON_SECRET || process.env.CAREER_WORKER_SECRET ? "configurado" : "ausente"],
    ];

    return texto(
      [
        `LEADS: ${db.leads.length} (reais ${reais.length}, demonstração ${demo.length})`,
        demo.length > 0 && reais.length > 0
          ? `  atenção: score médio demo ${media(demo)} vs real ${media(reais)} — como a lista ordena por score, os de demonstração ficam no topo`
          : null,
        `  fontes: ${top(porFonte, 5)}`,
        `  nichos: ${top(porNicho, 6)}`,
        `  cidades: ${top(porCidade, 6)}`,
        "",
        `USUÁRIOS: ${db.users.map((u) => `${u.name} (${u.role})`).join(", ")}`,
        `PROVEDOR DE BUSCA ATIVO: ${getActiveProvider().name}`,
        "",
        "ÚLTIMAS PROSPECÇÕES:",
        jobs.length ? tabela(jobs) : "  nenhuma",
        "",
        `CARREIRA: ${carreira.resumes.length} currículo(s), ${carreira.jobs.length} vaga(s), ${carreira.applications.length} candidatura(s), ${carreira.queue.filter((j) => j.status === "pendente" || j.status === "processando").length} job(s) na fila`,
        "",
        "AMBIENTE:",
        tabela(ambiente),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 2. Consulta de leads                                                */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "leads_buscar",
  {
    title: "Buscar leads no banco local",
    description:
      "Filtra os leads gravados por texto, fonte, nicho, cidade, score e presença de canais. Use para conferir o que uma prospecção realmente gravou, em vez de inferir pela interface.",
    inputSchema: {
      texto: z.string().optional().describe("Busca em nome, nicho e cidade"),
      fonte: z.string().optional().describe("google_places, demo, csv, manual…"),
      nicho: z.string().optional(),
      cidade: z.string().optional(),
      scoreMinimo: z.number().optional(),
      comSite: z.boolean().optional(),
      comEmail: z.boolean().optional(),
      comInstagram: z.boolean().optional(),
      incluirDemo: z.boolean().optional().describe("Inclui os leads de demonstração, ocultos por padrão quando há leads reais"),
      limite: z.number().optional().describe("Padrão 25"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const db = getDb();
    // Mesma regra das telas: com lead real na base, os de demonstração só
    // aparecem se forem pedidos.
    const universo = visibleLeads(db.leads, args.incluirDemo ?? false);
    const q = args.texto?.toLowerCase();
    const achados = universo.filter((l) => {
      if (q && !`${l.company_name} ${l.segment} ${l.city}`.toLowerCase().includes(q)) return false;
      if (args.fonte && l.source !== args.fonte) return false;
      if (args.nicho && !l.segment.toLowerCase().includes(args.nicho.toLowerCase())) return false;
      if (args.cidade && !l.city.toLowerCase().includes(args.cidade.toLowerCase())) return false;
      if (args.scoreMinimo !== undefined && (l.lead_score ?? 0) < args.scoreMinimo) return false;
      if (args.comSite !== undefined && Boolean(l.website) !== args.comSite) return false;
      if (args.comEmail !== undefined && Boolean(l.email) !== args.comEmail) return false;
      if (args.comInstagram !== undefined && Boolean(l.instagram) !== args.comInstagram) return false;
      return true;
    });
    const limite = args.limite ?? 25;
    const mostrados = [...achados].sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0)).slice(0, limite);
    return texto(
      [
        `${achados.length} lead(s) correspondem; mostrando ${mostrados.length}.` +
        (universo.length !== db.leads.length ? ` (${db.leads.length - universo.length} de demonstração ocultos — use incluirDemo)` : ""),
        "",
        tabela([["score", "empresa", "nicho", "cidade", "site", "ig", "fone", "mail", "fonte"], ...mostrados.map(linhaLead)]),
      ].join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 3. Auditoria de qualidade                                           */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "leads_auditar",
  {
    title: "Auditar a qualidade dos dados dos leads",
    description:
      "Procura os defeitos que já apareceram no uso real: e-mail de domínio diferente do site (costuma ser do fornecedor que fez o site), o mesmo e-mail em empresas diferentes, Instagram que não parece da empresa, leads sem nenhum canal de contato e empresas possivelmente duplicadas.",
    inputSchema: { fonte: z.string().optional().describe("Limita a auditoria a uma fonte") },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const db = getDb();
    const leads = args.fonte ? db.leads.filter((l) => l.source === args.fonte) : db.leads;

    const foraDoDominio: string[] = [];
    const repetidos = new Map<string, string[]>();
    const semCanal: string[] = [];
    const igEstranho: string[] = [];

    for (const l of leads) {
      if (l.email) {
        const d = dominioDe(l.website);
        const de = l.email.split("@")[1] ?? "";
        const publico = PROVEDORES_PUBLICOS.has(de);
        if (!publico && d && de !== d && !d.endsWith(de) && !de.endsWith(d)) {
          foraDoDominio.push(`${l.company_name} → ${l.email} (site ${d})`);
        }
        repetidos.set(l.email, [...(repetidos.get(l.email) ?? []), l.company_name]);
      }
      if (!l.phone && !l.whatsapp && !l.email && !l.instagram) semCanal.push(l.company_name);
      if (l.instagram && l.website) {
        const h = l.instagram.replace("@", "").toLowerCase().replace(/[._]/g, "");
        const nome = l.company_name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
        const base = (dominioDe(l.website) ?? "").split(".")[0]!.replace(/[^a-z0-9]/g, "");
        if (!nome.includes(h.slice(0, 6)) && !h.includes(base.slice(0, 6)) && !base.includes(h.slice(0, 6))) {
          igEstranho.push(`${l.company_name} → ${l.instagram} (site ${dominioDe(l.website)})`);
        }
      }
    }
    const compartilhados = [...repetidos.entries()].filter(([, empresas]) => empresas.length > 1);

    const chave = (l: Lead) => `${l.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}|${l.city.toLowerCase()}`;
    const porChave = new Map<string, string[]>();
    for (const l of leads) porChave.set(chave(l), [...(porChave.get(chave(l)) ?? []), l.id]);
    const duplicados = [...porChave.entries()].filter(([, ids]) => ids.length > 1);

    return texto(
      [
        `Auditoria de ${leads.length} lead(s)${args.fonte ? ` da fonte ${args.fonte}` : ""}.`,
        "",
        `E-MAIL DE OUTRO DOMÍNIO CORPORATIVO: ${foraDoDominio.length}  (Gmail/Hotmail da própria empresa não contam)`,
        ...foraDoDominio.slice(0, 10).map((s) => `  ${s}`),
        foraDoDominio.length ? "  (provável e-mail do fornecedor do site; rode scripts/sanear-emails.mjs)" : "",
        "",
        `MESMO E-MAIL EM EMPRESAS DIFERENTES: ${compartilhados.length}`,
        ...compartilhados.slice(0, 10).map(([email, empresas]) => `  ${email} → ${empresas.length}: ${empresas.slice(0, 4).join(", ")}`),
        "",
        `INSTAGRAM QUE NÃO PARECE DA EMPRESA: ${igEstranho.length}`,
        ...igEstranho.slice(0, 8).map((s) => `  ${s}`),
        "",
        `SEM NENHUM CANAL DE CONTATO: ${semCanal.length}`,
        ...semCanal.slice(0, 8).map((s) => `  ${s}`),
        "",
        `POSSÍVEIS DUPLICATAS (mesmo nome e cidade): ${duplicados.length}`,
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 4. Sondar a fonte sem gravar                                        */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "fonte_sondar",
  {
    title: "Sondar a fonte de empresas sem gravar nada",
    description:
      "Consulta o Google Places de verdade e mostra o que a fonte tem a oferecer: quantas empresas retornam, qual a proporção com site, Instagram e telefone, e uma amostra. Serve para responder 'esse filtro é viável nesse nicho/cidade?' antes de rodar uma prospecção. Não grava lead nenhum, mas consome cota da API.",
    inputSchema: {
      nicho: z.string().describe("Chave do nicho, ex.: imobiliaria, clinica, restaurante"),
      cidade: z.string(),
      pais: z.string().optional().describe("Padrão Brasil"),
      quantidade: z.number().optional().describe("Padrão 60"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const provider = new GooglePlacesProvider();
    if (!provider.isConfigured()) return texto("GOOGLE_PLACES_API_KEY não está definida — a sondagem usaria o diretório de demonstração, que não representa a realidade.");

    const quantidade = args.quantidade ?? 60;
    const inicio = Date.now();
    const empresas = await provider.search({
      niche: args.nicho,
      country: args.pais ?? "Brasil",
      city: args.cidade,
      quantity: quantidade,
      filters: {},
    });
    const pct = (n: number) => `${n} (${Math.round((n / Math.max(1, empresas.length)) * 100)}%)`;
    const semSite = empresas.filter((e) => !e.website);

    return texto(
      [
        `${empresas.length} empresas para "${args.nicho}" em ${args.cidade} (pedido: ${quantidade}) em ${Math.round((Date.now() - inicio) / 1000)}s`,
        "",
        `  com site:      ${pct(empresas.filter((e) => e.website).length)}`,
        `  SEM site:      ${pct(semSite.length)}`,
        `  com telefone:  ${pct(empresas.filter((e) => e.phone).length)}`,
        `  com avaliação: ${pct(empresas.filter((e) => (e.reviews_count ?? 0) > 0).length)}`,
        "",
        "Lembre que Instagram, WhatsApp e e-mail só aparecem depois do enriquecimento, que visita o site — por isso são raros em empresas sem site.",
        "",
        "AMOSTRA SEM SITE (as que atendem ao filtro “Sem site”):",
        semSite.length ? tabela(semSite.slice(0, 8).map((e) => [e.company_name.slice(0, 40), e.phone ?? "—"])) : "  nenhuma",
      ].join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 5. Explicar filtros                                                 */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "filtros_explicar",
  {
    title: "Explicar uma combinação de filtros",
    description:
      "Diz se a combinação de características desejadas é viável e, usando os leads já gravados, estima quantos passariam por ela. Útil para entender por que uma busca voltou vazia.",
    inputSchema: FILTROS_SCHEMA,
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const filtros = args as SearchParams["filters"];
    const avisos = filterWarnings(filtros);
    const db = getDb();
    const contagem = new Map<string, number>();
    let passariam = 0;
    for (const l of db.leads) {
      const motivos = rejectionReasons(
        {
          company_name: l.company_name,
          segment: l.segment,
          country: l.country,
          city: l.city,
          source: l.source,
          phone: l.phone ?? undefined,
          whatsapp: l.whatsapp ?? undefined,
          email: l.email ?? undefined,
          website: l.website ?? undefined,
          instagram: l.instagram ?? undefined,
          reviews_count: l.reviews_count ?? undefined,
          website_quality: l.website_quality,
          instagram_active: l.instagram_active,
          marketing_signals: l.marketing_signals,
          business_active: l.business_active,
        },
        filtros
      );
      if (motivos.length === 0) passariam += 1;
      for (const m of motivos) contagem.set(m, (contagem.get(m) ?? 0) + 1);
    }
    const ativos = Object.entries(filtros).filter(([, v]) => v).map(([k]) => FILTER_LABEL[k] ?? k);

    return texto(
      [
        `Filtros ativos: ${ativos.length ? ativos.join(", ") : "nenhum"}`,
        "",
        avisos.length ? `AVISOS:\n${avisos.map((a) => `  • ${a}`).join("\n")}` : "Nenhuma combinação contraditória detectada.",
        "",
        `Sobre os ${db.leads.length} leads já gravados, ${passariam} passariam por esses filtros.`,
        contagem.size
          ? `\nDescarte por critério:\n${[...contagem.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${FILTER_LABEL[k] ?? k}: ${n}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 6. Prospecção de verdade                                            */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "prospectar",
  {
    title: "Rodar uma prospecção (grava leads)",
    description:
      "Executa o mesmo job da tela Prospectar: busca na fonte, enriquece visitando os sites, aplica os filtros, grava os leads e analisa cada um. ESCREVE no banco local e consome cota do Google. Devolve o resultado com o descarte por critério.",
    inputSchema: {
      nicho: z.string(),
      cidade: z.string(),
      quantidade: z.number().describe("1 a 200"),
      pais: z.string().optional(),
      filtros: z.object(FILTROS_SCHEMA).optional(),
      esperarSegundos: z.number().optional().describe("Quanto esperar pelo término. Padrão 180."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    const db = getDb();
    const usuario = db.users[0];
    if (!usuario) return texto("Nenhum usuário no banco local — não há a quem atribuir o job.");

    const job = createProspectingJob(
      {
        niche: args.nicho,
        country: args.pais ?? "Brasil",
        city: args.cidade,
        quantity: args.quantidade,
        filters: (args.filtros ?? {}) as SearchParams["filters"],
      },
      usuario.id
    );

    const limite = (args.esperarSegundos ?? 180) * 1000;
    const inicio = Date.now();
    let atual: ProspectingJob | undefined = job;
    while (Date.now() - inicio < limite) {
      atual = getDb().prospecting_jobs.find((j) => j.id === job.id);
      if (!atual || atual.status === "completed" || atual.status === "failed") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!atual) return texto("O job desapareceu do banco.");

    const encontrados = atual.found_lead_ids
      .map((id) => getDb().leads.find((l) => l.id === id))
      .filter(Boolean) as Lead[];

    return texto(
      [
        `Status: ${atual.status} · pedido ${atual.params.quantity} · encontrados ${atual.found_lead_ids.length} · duplicados ${atual.duplicates} · descartados ${atual.filtered ?? 0}`,
        atual.filtered_by && Object.keys(atual.filtered_by).length
          ? `\nDescarte por critério:\n${Object.entries(atual.filtered_by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${FILTER_LABEL[k] ?? k}: ${n}`).join("\n")}`
          : "",
        atual.errors.length ? `\nErros:\n${atual.errors.slice(0, 5).map((e) => `  ${e}`).join("\n")}` : "",
        encontrados.length
          ? `\nLeads gravados:\n${tabela([["score", "empresa", "nicho", "cidade", "site", "ig", "fone", "mail", "fonte"], ...encontrados.map(linhaLead)])}`
          : "\nNenhum lead gravado.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 7. Amostra de análise                                               */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "analise_amostrar",
  {
    title: "Ver a análise gerada para alguns leads",
    description:
      "Roda o motor de análise sobre leads do banco e mostra o texto produzido, lado a lado. Serve para verificar se o diagnóstico fala do negócio específico ou se está saindo igual para empresas diferentes.",
    inputSchema: {
      nicho: z.string().optional().describe("Limita a um nicho, para comparar empresas parecidas"),
      quantidade: z.number().optional().describe("Padrão 3"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const db = getDb();
    const candidatos = args.nicho
      ? db.leads.filter((l) => l.segment.toLowerCase().includes(args.nicho!.toLowerCase()))
      : db.leads;
    const amostra = candidatos.slice(0, args.quantidade ?? 3);
    if (amostra.length === 0) return texto("Nenhum lead corresponde.");

    const blocos = amostra.map((l) => {
      const a = engineAnalyze(l);
      return [
        `### ${l.company_name} — ${l.segment}, ${l.city}`,
        `problema: ${a.main_problem}`,
        `solução: ${a.recommended_solution} · confiança ${a.confidence}`,
      ].join("\n");
    });

    const problemas = amostra.map((l) => engineAnalyze(l).main_problem);
    const identicos = new Set(problemas).size < problemas.length;

    return texto(
      [
        `Motor: ${isLlmConfigured() ? "OpenAI configurada (a aplicação usa o LLM; esta amostra mostra o motor determinístico)" : "determinístico (sem OPENAI_API_KEY)"}`,
        identicos ? "ATENÇÃO: há textos idênticos entre empresas diferentes nesta amostra.\n" : "",
        blocos.join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 8. Testar a escolha de e-mail                                       */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "email_testar_extracao",
  {
    title: "Testar a escolha de e-mail num HTML",
    description:
      "Aplica a regra de escolha de e-mail de contato (pickEmail) sobre um trecho de HTML e um domínio de site, mostrando qual endereço seria gravado. Serve para conferir casos novos sem rodar uma prospecção inteira.",
    inputSchema: {
      html: z.string().describe("Trecho de HTML da página da empresa"),
      site: z.string().optional().describe("URL do site da empresa, ex.: https://imob.com.br"),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const escolhido = pickEmail(args.html, args.site);
    const todos = [...new Set(args.html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])];
    return texto(
      [
        `E-mails no HTML: ${todos.length ? todos.join(", ") : "nenhum"}`,
        `Site informado: ${args.site ?? "(nenhum)"}`,
        "",
        `Escolhido: ${escolhido ?? "nenhum — todos são de domínio de terceiro (provável fornecedor do site)"}`,
      ].join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */
/* 9. Módulo Carreira                                                  */
/* ------------------------------------------------------------------ */

servidor.registerTool(
  "carreira_estado",
  {
    title: "Estado do módulo Carreira",
    description:
      "Currículos, análises, vagas, candidaturas e a fila de jobs do módulo Carreira, com o estado de cada job pendente. Serve para ver se a fila travou ou se uma candidatura ficou presa.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const c = getCareerData();
    const fila = c.queue
      .filter((j) => j.status !== "concluido")
      .slice(0, 12)
      .map((j) => [j.kind, j.status, `tent. ${j.attempts}/${j.max_attempts}`, j.next_run_at.slice(0, 16), (j.last_error ?? "").slice(0, 40)]);

    const porEstado = new Map<string, number>();
    for (const a of c.applications) porEstado.set(a.processing_status, (porEstado.get(a.processing_status) ?? 0) + 1);

    return texto(
      [
        `Currículos: ${c.resumes.length} · análises: ${c.analyses.length} · links inspecionados: ${c.link_checks.length}`,
        `Vagas: ${c.jobs.length} · compatibilidades: ${c.matches.length} · campanhas: ${c.campaigns.length}`,
        `Candidaturas: ${c.applications.length}${porEstado.size ? ` — ${[...porEstado.entries()].map(([k, n]) => `${k}: ${n}`).join(", ")}` : ""}`,
        "",
        "FILA:",
        fila.length ? tabela([["tipo", "estado", "tentativas", "próxima", "último erro"], ...fila]) : "  vazia",
      ].join("\n")
    );
  }
);

/* ------------------------------------------------------------------ */

/**
 * Sem `await` de topo: o tsx compila este arquivo como CommonJS (o
 * package.json do projeto não declara `"type": "module"`), e top-level
 * await falha nesse formato.
 *
 * O log vai para stderr de propósito — stdout é o canal do protocolo MCP, e
 * qualquer linha solta ali corrompe a conversa com o cliente.
 */
async function iniciar() {
  const transporte = new StdioServerTransport();
  await servidor.connect(transporte);
  console.error("[prospecatlas-dev] servidor MCP pronto");
}

iniciar().catch((err) => {
  console.error("[prospecatlas-dev] falha ao iniciar:", err);
  process.exit(1);
});
