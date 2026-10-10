import "server-only";
import { phoneKey } from "@/lib/outreach-policy";
import { logAgentEvent } from "@/services/agents/log";
import { agentRepo, orgId, UniqueViolationError } from "@/services/agents/repository";
import type { ChannelBlock } from "@/types/agents";

/**
 * Lista de bloqueio: quem não pode receber mensagem.
 *
 * Entram aqui quem pediu para parar, números que não têm WhatsApp e bloqueios
 * manuais. É consultada antes de preparar uma abordagem e de novo no instante
 * do envio — o bloqueio feito depois de a mensagem ser aprovada ainda vale.
 */

export async function blockedKeys(): Promise<Set<string>> {
  return new Set((await agentRepo().list("channel_blocklist")).map((b) => b.id));
}

export async function isBlocked(phone: string): Promise<boolean> {
  return (await agentRepo().get("channel_blocklist", phoneKey(phone))) !== null;
}

export async function blockPhone(phone: string, reason: string, source: ChannelBlock["source"] = "manual"): Promise<ChannelBlock> {
  const block: ChannelBlock = {
    id: phoneKey(phone),
    organization_id: orgId(),
    phone,
    reason,
    source,
    created_at: new Date().toISOString(),
  };
  try {
    await agentRepo().insert("channel_blocklist", block);
    await logAgentEvent("seller", "info", "blocklist.added", `Número bloqueado (${source}): ${reason}.`);
    return block;
  } catch (err) {
    // Já bloqueado: o primeiro motivo vale, nada a fazer.
    if (err instanceof UniqueViolationError) return (await agentRepo().get("channel_blocklist", block.id)) ?? block;
    throw err;
  }
}

export async function unblockPhone(phone: string): Promise<boolean> {
  const removed = await agentRepo().remove("channel_blocklist", { id: phoneKey(phone) });
  if (removed > 0) await logAgentEvent("seller", "info", "blocklist.removed", "Número removido da lista de bloqueio.");
  return removed > 0;
}

export async function listBlocklist(): Promise<ChannelBlock[]> {
  return agentRepo().list("channel_blocklist", { orderBy: "created_at", desc: true, limit: 200 });
}
