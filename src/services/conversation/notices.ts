import "server-only";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";
import { ProviderError, type SendResult, type SendTextInput } from "@/providers/whatsapp/types";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo } from "@/services/agents/repository";
import { whatsappGateway } from "@/services/whatsapp/config";
import type { OwnerNotice } from "@/types/agents";

/**
 * Aviso ao WhatsApp pessoal do dono.
 *
 * É a única mensagem que o Vendedor manda a alguém que não é lead, e vai para um
 * número que VOCÊ configurou. Por isso não passa por janela, teto nem aprovação
 * — mas continua passando pela autorização do gateway e pela idempotência: o
 * mesmo aviso nunca sai duas vezes, e um envio sem confirmação nunca é repetido.
 *
 * Se o número de prospecção estiver desconectado ou for banido, o aviso não sai:
 * o sino e o painel mostram isso, e é por isso que o sino também avisa sempre.
 */

const MAX_ATTEMPTS = 4;
const RECHECK_MS = 60_000;
const CONFIG_WAIT_MS = 10 * 60_000;

export interface NoticeGateway {
  status(): Promise<{ status: string; dryRun: boolean }>;
  sendText(input: SendTextInput): Promise<SendResult>;
}

export interface NoticeDeps {
  now?: () => Date;
  gateway?: () => NoticeGateway | null;
}

function bell(title: string, body: string) {
  const db = getDb();
  const userId = db.users.find((u) => u.role === "owner")?.id ?? db.users[0]?.id;
  if (!userId) return;
  db.notifications.unshift({ id: uid("ntf"), organization_id: db.organization.id, user_id: userId, title, body, link: "/agentes/vendedor", read: false, created_at: new Date().toISOString() });
  saveDb();
}

export type NoticeOutcome = "sent" | "deferred" | "retry" | "failed" | "uncertain" | "skipped";

export async function processOwnerNotice(id: string, deps: NoticeDeps = {}): Promise<NoticeOutcome> {
  const repo = agentRepo();
  const now = (deps.now ?? (() => new Date()))();
  const notice = await repo.get("owner_notices", id);
  if (!notice || notice.status !== "pendente" || notice.not_before > now.toISOString()) return "skipped";

  const update = (patch: Partial<OwnerNotice>) => repo.update("owner_notices", id, { ...patch, updated_at: new Date().toISOString() });
  const later = async (reason: string, ms: number): Promise<NoticeOutcome> => {
    await update({ not_before: new Date(now.getTime() + ms).toISOString(), last_error: reason });
    return "deferred";
  };

  const gateway = (deps.gateway ?? whatsappGateway)();
  if (!gateway) return later("gateway do WhatsApp não configurado", CONFIG_WAIT_MS);
  try {
    const status = await gateway.status();
    if (status.status !== "CONNECTED") return later("WhatsApp desconectado", RECHECK_MS);
  } catch {
    return later("gateway do WhatsApp inacessível", RECHECK_MS);
  }

  try {
    const sent = await gateway.sendText({ to: notice.phone, body: notice.body, clientReference: notice.idempotency_key });
    await update({ status: "enviado", provider_message_id: sent.providerMessageId, sent_at: now.toISOString(), last_error: null });
    await logAgentEvent("seller", "info", "owner_notice.sent", "Aviso de reunião enviado ao seu WhatsApp.", { notice_id: id });
    return "sent";
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError("TEMPORARY", err instanceof Error ? err.message : "erro desconhecido");
    // Nada saiu e a culpa não é do aviso: espera sem gastar tentativa.
    if (e.kind === "DISCONNECTED" || e.kind === "DRY_RUN") {
      return later(e.kind === "DRY_RUN" ? "gateway em modo de teste: aguardando a ativação dos envios reais" : "WhatsApp desconectado", RECHECK_MS);
    }
    if (e.kind === "AUTH" || e.providerCode === 403 || e.providerCode === 501) return later(`configuração do envio: ${e.message}`, CONFIG_WAIT_MS);
    // Sem confirmação: pode ter chegado. Não repete, para não duplicar.
    if (e.uncertain) {
      await update({ status: "incerto", last_error: e.message.slice(0, 300) });
      bell("Aviso de reunião sem confirmação", "O aviso ao seu WhatsApp pode ter chegado ou não. A reunião está no CRM, em Agentes › Vendedor.");
      await logAgentEvent("seller", "warn", "owner_notice.uncertain", "Aviso ao seu WhatsApp sem confirmação: pode ter chegado. NÃO será reenviado.", { notice_id: id });
      return "uncertain";
    }
    if (e.retryable) {
      const attempts = notice.attempts + 1;
      if (attempts < MAX_ATTEMPTS) {
        await update({ attempts, last_error: e.message.slice(0, 300), not_before: new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)).toISOString() });
        return "retry";
      }
      await update({ status: "falhou", attempts, last_error: e.message.slice(0, 300) });
    } else {
      await update({ status: "falhou", last_error: e.message.slice(0, 300) });
    }
    bell("Não consegui avisar no seu WhatsApp", `O aviso de reunião falhou: ${e.message.slice(0, 100)}. A reunião está no CRM.`);
    await logAgentEvent("seller", "error", "owner_notice.failed", `Aviso de reunião ao seu WhatsApp falhou: ${e.message}`, { notice_id: id });
    return "failed";
  }
}

/** Envia os avisos vencidos, do mais antigo ao mais novo. */
export async function processDueOwnerNotices(deps: NoticeDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const due = (await agentRepo().list("owner_notices", { where: { status: "pendente" }, orderBy: "created_at", limit: 20 })).filter((n) => n.not_before <= now);
  let sent = 0;
  for (const n of due) {
    if ((await processOwnerNotice(n.id, deps)) === "sent") sent += 1;
  }
  return sent;
}
