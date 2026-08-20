import "server-only";
import { after } from "next/server";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { getActiveProvider } from "@/providers/registry";
import { findDuplicate } from "@/services/dedupe";
import { enrichBatch } from "@/services/enrichment";
import { hasActiveFilters, matchesFilters } from "@/services/lead-filter";
import { createLeadFromRaw, logActivity } from "@/services/lead-service";
import { aiAnalyzeLead } from "@/ai";
import type { JobStep, Lead, ProspectingJob, SearchParams } from "@/types";

/**
 * Job assíncrono de prospecção.
 *
 * Roda em background no servidor; a UI acompanha o progresso real
 * (cada contador reflete itens efetivamente processados — nunca
 * porcentagens falsas). Erros em um lead não interrompem a busca.
 */

function makeSteps(total: number): JobStep[] {
  return [
    { key: "finding", label: "Encontrando empresas", done: 0, total, status: "processing" },
    { key: "enriching", label: "Enriquecendo informações", done: 0, total: 0, status: "queued" },
    { key: "social", label: "Procurando presença digital", done: 0, total: 0, status: "queued" },
    { key: "analyzing", label: "Analisando oportunidades", done: 0, total: 0, status: "queued" },
    { key: "scoring", label: "Calculando score", done: 0, total: 0, status: "queued" },
  ];
}

export function createProspectingJob(params: SearchParams, userId: string): ProspectingJob {
  const db = getDb();

  let campaignId: string | null = null;
  if (params.campaignName?.trim()) {
    const existing = db.campaigns.find(
      (c) => c.name.toLowerCase() === params.campaignName!.trim().toLowerCase()
    );
    if (existing) {
      campaignId = existing.id;
    } else {
      const campaign = {
        id: uid("cmp"),
        organization_id: db.organization.id,
        name: params.campaignName.trim(),
        description: null,
        created_at: nowIso(),
        archived: false,
      };
      db.campaigns.push(campaign);
      campaignId = campaign.id;
    }
  }

  const job: ProspectingJob = {
    id: uid("job"),
    organization_id: db.organization.id,
    params,
    status: "queued",
    steps: makeSteps(params.quantity),
    found_lead_ids: [],
    duplicates: 0,
    filtered: 0,
    errors: [],
    campaign_id: campaignId,
    created_at: nowIso(),
    finished_at: null,
  };
  db.prospecting_jobs.push(job);
  saveDb();

  // roda após a resposta da action — em serverless (Vercel), after() mantém
  // a função viva até o job terminar, em vez de arriscar o corte da execução
  after(() => runProspectingJob(job.id, userId));

  return job;
}

async function runProspectingJob(jobId: string, userId: string): Promise<void> {
  const db = getDb();
  const job = db.prospecting_jobs.find((j) => j.id === jobId);
  if (!job) return;

  const step = (key: JobStep["key"]) => job.steps.find((s) => s.key === key)!;

  try {
    job.status = "processing";
    saveDb();

    /* 1. Encontrar empresas — busca com excedente para compensar
       duplicados e empresas descartadas pelos filtros */
    const provider = getActiveProvider();
    const filters = job.params.filters;
    const overfetch = hasActiveFilters(filters) ? 3 : 1.5;
    const fetchTarget =
      provider.id === "google_places"
        ? Math.min(60, Math.max(job.params.quantity + 5, Math.ceil(job.params.quantity * overfetch)))
        : job.params.quantity;

    // nunca repetir empresas de buscas anteriores, mesmo que os leads tenham sido removidos
    db.seen_source_ids ??= [];
    const raws = await provider.search({
      ...job.params,
      quantity: fetchTarget,
      excludeSourceIds: db.seen_source_ids,
    });
    const newIds = raws.map((r) => r.source_id).filter((id): id is string => Boolean(id));
    db.seen_source_ids = [...db.seen_source_ids, ...newIds].slice(-10_000);

    const finding = step("finding");
    finding.done = raws.length;
    finding.total = Math.max(raws.length, 1);
    finding.status = "completed";

    /* 2. Deduplicação contra a base existente */
    const candidates = raws.filter((raw) => {
      if (findDuplicate(raw, db.leads)) {
        job.duplicates += 1;
        return false;
      }
      return true;
    });

    const enriching = step("enriching");
    const social = step("social");
    enriching.total = social.total = candidates.length;
    enriching.status = social.status = candidates.length > 0 ? "processing" : "completed";
    saveDb();

    /* 3. Enriquecimento real: visita o site e extrai Instagram, e-mail,
       WhatsApp, qualidade do site e sinais de marketing */
    const enriched = await enrichBatch(candidates, (done) => {
      enriching.done = social.done = done;
      saveDb();
    });
    enriching.status = social.status = "completed";

    /* 4. Filtros escolhidos pelo usuário — aplicados após o
       enriquecimento, quando os dados realmente existem */
    const matched = enriched.filter((raw) => matchesFilters(raw, filters));
    job.filtered = enriched.length - matched.length;
    const selected = matched.slice(0, job.params.quantity);

    const analyzing = step("analyzing");
    const scoring = step("scoring");
    analyzing.total = scoring.total = selected.length;
    analyzing.status = scoring.status = selected.length > 0 ? "processing" : "completed";
    saveDb();

    /* 5. Criação + análise de IA + score — erro em um lead não derruba a busca */
    for (const raw of selected) {
      try {
        const lead = createLeadFromRaw(raw, job.campaign_id, null);
        job.found_lead_ids.push(lead.id);
        await analyzeAndStore(lead, userId);
      } catch (err) {
        job.errors.push(
          `Não conseguimos processar "${raw.company_name}": ${err instanceof Error ? err.message : "erro desconhecido"}`
        );
      }
      analyzing.done += 1;
      scoring.done += 1;
      saveDb();
    }

    analyzing.status = scoring.status = "completed";
    job.status = "completed";
    job.finished_at = nowIso();

    const notes: string[] = [];
    if (job.duplicates > 0) notes.push(`${job.duplicates} duplicados ignorados`);
    if ((job.filtered ?? 0) > 0) notes.push(`${job.filtered} fora do perfil descartados`);

    // notificação de conclusão
    db.notifications.unshift({
      id: uid("ntf"),
      organization_id: db.organization.id,
      user_id: userId,
      title: `Prospecção concluída: ${job.found_lead_ids.length} leads encontrados`,
      body: notes.length > 0 ? `${notes.join(" · ")}.` : null,
      link: `/leads`,
      read: false,
      created_at: nowIso(),
    });
    saveDb();
  } catch (err) {
    job.status = "failed";
    job.errors.push(err instanceof Error ? err.message : "Falha inesperada na busca");
    job.finished_at = nowIso();
    for (const s of job.steps) if (s.status === "processing") s.status = "failed";
    saveDb();
  }
}

/** Analisa um lead com IA e persiste análise + eventual ajuste de status */
export async function analyzeAndStore(lead: Lead, userId: string | null): Promise<void> {
  const db = getDb();
  const { output, model } = await aiAnalyzeLead(lead, db.company_profile);

  db.lead_analysis = db.lead_analysis.filter((a) => a.lead_id !== lead.id);
  db.lead_analysis.push({
    id: uid("ana"),
    lead_id: lead.id,
    ...output,
    created_at: nowIso(),
    model,
  });

  if (lead.status === "novo") {
    lead.status = "analisado";
    const stage = db.pipeline_stages.find((s) => s.name === "Analisado");
    if (stage) lead.pipeline_stage_id = stage.id;
    lead.stage_entered_at = nowIso();
  }
  lead.updated_at = nowIso();
  logActivity(
    lead.id,
    "lead_analisado",
    `Análise concluída — ${output.recommended_solution} (confiança ${output.confidence}%)`,
    userId
  );
  saveDb();
}
