import "server-only";
import { getDb, nowIso, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { getActiveProvider } from "@/providers/registry";
import { findDuplicate } from "@/services/dedupe";
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
    errors: [],
    campaign_id: campaignId,
    created_at: nowIso(),
    finished_at: null,
  };
  db.prospecting_jobs.push(job);
  saveDb();

  // dispara o processamento sem bloquear a resposta da action
  void runProspectingJob(job.id, userId);

  return job;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runProspectingJob(jobId: string, userId: string): Promise<void> {
  const db = getDb();
  const job = db.prospecting_jobs.find((j) => j.id === jobId);
  if (!job) return;

  const step = (key: JobStep["key"]) => job.steps.find((s) => s.key === key)!;

  try {
    job.status = "processing";
    saveDb();

    /* 1. Encontrar empresas */
    const provider = getActiveProvider();
    const raws = await provider.search(job.params);
    const finding = step("finding");
    finding.done = raws.length;
    finding.total = Math.max(raws.length, finding.total);
    finding.status = "completed";

    const perLeadSteps: Array<JobStep["key"]> = ["enriching", "social", "analyzing", "scoring"];
    for (const key of perLeadSteps) {
      const s = step(key);
      s.total = raws.length;
      s.status = raws.length > 0 ? "processing" : "completed";
    }
    saveDb();

    /* 2..5. Pipeline por lead — erro em um lead não derruba a busca */
    for (const raw of raws) {
      try {
        // deduplicação antes de salvar
        const dup = findDuplicate(raw, db.leads);
        if (dup) {
          job.duplicates += 1;
          for (const key of perLeadSteps) step(key).done += 1;
          saveDb();
          continue;
        }

        const lead = createLeadFromRaw(raw, job.campaign_id, null);
        job.found_lead_ids.push(lead.id);

        step("enriching").done += 1;
        saveDb();
        await sleep(60);

        step("social").done += 1;
        saveDb();
        await sleep(40);

        // análise automática de oportunidade
        await analyzeAndStore(lead, userId);
        step("analyzing").done += 1;
        saveDb();

        step("scoring").done += 1;
        saveDb();
        await sleep(30);
      } catch (err) {
        job.errors.push(
          `Não conseguimos processar "${raw.company_name}": ${err instanceof Error ? err.message : "erro desconhecido"}`
        );
        for (const key of perLeadSteps) {
          const s = step(key);
          if (s.done < s.total) s.done += 1;
        }
        saveDb();
      }
    }

    for (const key of perLeadSteps) step(key).status = "completed";
    job.status = "completed";
    job.finished_at = nowIso();

    // notificação de conclusão
    db.notifications.unshift({
      id: uid("ntf"),
      organization_id: db.organization.id,
      user_id: userId,
      title: `Prospecção concluída: ${job.found_lead_ids.length} leads encontrados`,
      body:
        job.duplicates > 0
          ? `${job.duplicates} duplicados foram ignorados automaticamente.`
          : null,
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
