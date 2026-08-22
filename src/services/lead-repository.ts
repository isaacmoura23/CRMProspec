import "server-only";
import { after } from "next/server";
import { getDb, setLeadsChangeListener } from "@/lib/store";
import { getSupabase, isSupabaseEnabled } from "@/lib/supabase";
import type { Lead, LeadAnalysis, LeadScoreEntry } from "@/types";

/**
 * Persistência de leads no Supabase.
 *
 * O desenho é de cache de leitura com escrita espelhada, e não de "trocar a
 * fonte dos leads", porque o resto do sistema lê `db.leads` como um array
 * síncrono e cruza essa lista com tarefas, conversas e propostas em memória.
 * Trocar cada leitura por consulta transformaria esses cruzamentos em uma
 * ida à rede por item — dezenas por página.
 *
 * Então: no primeiro acesso da instância os leads vêm do banco de uma vez
 * só e passam a viver no snapshot; as telas continuam idênticas. As
 * mutações seguem sendo feitas no objeto em memória e depois espelhadas
 * para o banco, o que preserva os 88 pontos de acesso já existentes.
 */

type GlobalWithSync = typeof globalThis & {
  __crmLeadsLoaded?: boolean;
  __crmLeadsSyncedAt?: string;
  __crmSyncScheduled?: boolean;
};

const TABLE_LEADS = "app_leads";
const TABLE_ANALYSIS = "app_lead_analysis";
const TABLE_SCORES = "app_lead_score_history";

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

/**
 * Carrega leads do banco para o snapshot, uma vez por instância.
 *
 * Idempotente: chamadas seguintes retornam de imediato. Se o banco estiver
 * indisponível, o snapshot local segue valendo — a aplicação não cai por
 * causa do Supabase.
 */
export async function ensureLeadsLoaded(): Promise<void> {
  const g = globalThis as GlobalWithSync;
  if (g.__crmLeadsLoaded || !isSupabaseEnabled()) return;
  g.__crmLeadsLoaded = true; // trava antes do await: evita carga dupla concorrente

  const supabase = getSupabase();
  if (!supabase) return;

  const db = getDb();
  try {
    const [leads, analysis, scores] = await Promise.all([
      supabase.from(TABLE_LEADS).select("*").eq("organization_id", db.organization.id),
      supabase.from(TABLE_ANALYSIS).select("*").eq("organization_id", db.organization.id),
      supabase.from(TABLE_SCORES).select("*").eq("organization_id", db.organization.id),
    ]);

    if (leads.error) throw leads.error;

    // Sem nada no banco, é a primeira execução: sobe o que existe localmente
    // em vez de apagar os leads de demonstração.
    if ((leads.data?.length ?? 0) === 0 && db.leads.length > 0) {
      g.__crmLeadsSyncedAt = undefined;
      scheduleSync();
      return;
    }

    db.leads = (leads.data ?? []) as Lead[];
    if (!analysis.error) db.lead_analysis = (analysis.data ?? []) as LeadAnalysis[];
    if (!scores.error) db.lead_score_history = (scores.data ?? []) as LeadScoreEntry[];
    g.__crmLeadsSyncedAt = nowStamp();
  } catch (err) {
    console.error("[supabase] falha ao carregar leads — usando snapshot local:", err);
    g.__crmLeadsLoaded = false; // permite nova tentativa na próxima requisição
  }
}

/* ------------------------------------------------------------------ */
/* Escrita                                                             */
/* ------------------------------------------------------------------ */

function nowStamp(): string {
  return new Date().toISOString();
}

/** Converte o Lead do domínio para a linha da tabela. */
function toLeadRow(lead: Lead, organizationId: string) {
  return { ...lead, organization_id: lead.organization_id || organizationId };
}

/** 23505 é a violação de unicidade do Postgres. */
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

/**
 * Reenvia um a um após uma colisão no lote e devolve os ids recusados.
 * Só é chamado no caminho de exceção, então o custo extra é raro.
 */
async function upsertOneByOne(leads: Lead[], orgId: string): Promise<string[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const rejeitados: string[] = [];

  for (const lead of leads) {
    const { error } = await supabase
      .from(TABLE_LEADS)
      .upsert(toLeadRow(lead, orgId), { onConflict: "id" });
    if (error) {
      if (isUniqueViolation(error)) rejeitados.push(lead.id);
      else console.error(`[supabase] falha ao gravar lead ${lead.id}:`, error);
    }
  }
  return rejeitados;
}

/**
 * Espelha para o banco tudo que mudou desde a última sincronização.
 *
 * O corte é por `updated_at`, que toda mutação de lead atualiza. Leads e
 * análises vão por upsert, então reenviar algo já gravado é inofensivo.
 */
export async function syncLeadsToSupabase(): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const g = globalThis as GlobalWithSync;
  const db = getDb();
  const since = g.__crmLeadsSyncedAt;
  const startedAt = nowStamp();

  const pending = since
    ? db.leads.filter((l) => (l.updated_at ?? l.created_at) > since)
    : db.leads;
  if (pending.length === 0) {
    g.__crmLeadsSyncedAt = startedAt;
    return;
  }

  try {
    const orgId = db.organization.id;
    const { error } = await supabase
      .from(TABLE_LEADS)
      .upsert(pending.map((l) => toLeadRow(l, orgId)), { onConflict: "id" });

    if (error && isUniqueViolation(error)) {
      // Algum lead colide com um já existente por telefone, Instagram ou
      // nome+cidade — outra prospecção o cadastrou primeiro. O upsert é em
      // lote e falha inteiro, então aqui separamos o joio: quem passa é
      // gravado, quem colide sai do snapshot para não virar lead repetido
      // na tela.
      const rejeitados = await upsertOneByOne(pending, orgId);
      if (rejeitados.length > 0) {
        const remover = new Set(rejeitados);
        db.leads = db.leads.filter((l) => !remover.has(l.id));
        db.lead_analysis = db.lead_analysis.filter((a) => !remover.has(a.lead_id));
        db.lead_score_history = db.lead_score_history.filter((s) => !remover.has(s.lead_id));
        console.warn(
          `[supabase] ${rejeitados.length} lead(s) descartado(s) por já existirem na base`
        );
      }
    } else if (error) {
      throw error;
    }

    // Análises e histórico acompanham os leads que acabaram de subir.
    const ids = new Set(db.leads.map((l) => l.id).filter((id) => pending.some((p) => p.id === id)));
    const analysis = db.lead_analysis
      .filter((a) => ids.has(a.lead_id))
      .map((a) => ({ ...a, organization_id: orgId }));
    if (analysis.length) {
      const res = await supabase.from(TABLE_ANALYSIS).upsert(analysis, { onConflict: "id" });
      if (res.error) console.error("[supabase] análises não sincronizadas:", res.error);
    }

    const scores = db.lead_score_history
      .filter((s) => ids.has(s.lead_id))
      .map((s) => ({ ...s, organization_id: orgId }));
    if (scores.length) {
      const res = await supabase.from(TABLE_SCORES).upsert(scores, { onConflict: "id" });
      if (res.error) console.error("[supabase] histórico de score não sincronizado:", res.error);
    }

    g.__crmLeadsSyncedAt = startedAt;
  } catch (err) {
    // Mantém `__crmLeadsSyncedAt` como estava: o que falhou entra na
    // próxima tentativa em vez de ser dado como salvo.
    console.error("[supabase] falha ao sincronizar leads:", err);
  }
}

/**
 * Agenda a sincronização para depois da resposta.
 *
 * Uma única vez por requisição, mesmo que `saveDb()` seja chamado dez vezes
 * — é o caso do job de prospecção, que grava progresso a cada etapa.
 */
export function scheduleSync(): void {
  if (!isSupabaseEnabled()) return;
  const g = globalThis as GlobalWithSync;
  if (g.__crmSyncScheduled) return;
  g.__crmSyncScheduled = true;

  const run = async () => {
    g.__crmSyncScheduled = false;
    await syncLeadsToSupabase();
  };

  try {
    after(() => run().catch((err) => console.error("[supabase] sync falhou:", err)));
  } catch {
    // Fora do escopo de uma requisição (ex.: dentro do job já em after()).
    void run().catch((err) => console.error("[supabase] sync falhou:", err));
  }
}

// `saveDb()` passa a disparar a sincronização sem que o store precise
// conhecer o Supabase.
setLeadsChangeListener(scheduleSync);

/** Remoção de fato — o app arquiva, mas a exclusão existe para o import/dedupe. */
export async function deleteLeadFromSupabase(leadId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from(TABLE_LEADS).delete().eq("id", leadId);
  if (error) console.error("[supabase] falha ao remover lead:", error);
}
