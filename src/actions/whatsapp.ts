"use server";

import { revalidatePath } from "next/cache";
import { getAdminUser, getCurrentUser } from "@/lib/auth";
import { ADMIN_DENIED, canAdminister } from "@/lib/permissions";
import { logAgentEvent } from "@/services/agents/log";
import { whatsappGateway } from "@/services/whatsapp/config";
import { describeGatewayError, loadWhatsappPanelState } from "@/services/whatsapp/panel";
import type { WhatsappActionResult, WhatsappPanelState } from "@/types/whatsapp";

/**
 * Ações da tela de conexão do WhatsApp. Conectar, desconectar e sair vinculam
 * ou desvinculam o número da empresa: só owner e admin, verificado aqui no
 * servidor.
 */

/*
 * O auxiliar privado fica ANTES das actions exportadas: o teste que confere o papel
 * de cada action lê o corpo de uma exportação até a próxima, e um helper que grava
 * (revalidatePath) no meio dela faria uma action só de leitura parecer de escrita.
 */
async function run(
  action: "connect" | "disconnect" | "logout",
  who: string
): Promise<WhatsappActionResult> {
  const gateway = whatsappGateway();
  if (!gateway) return { ok: false, error: "O gateway do WhatsApp não está configurado neste ambiente." };
  try {
    if (action === "connect") await gateway.connect();
    else await gateway.disconnect(action === "logout");
  } catch (err) {
    return { ok: false, error: describeGatewayError(err) };
  }
  const message = {
    connect: "Gerando o QR Code…",
    disconnect: "WhatsApp desconectado. A sessão foi guardada: reconectar não pede novo QR.",
    logout: "Saiu do dispositivo. Para voltar, será preciso ler o QR Code de novo.",
  }[action];
  await logAgentEvent("sistema", "info", `whatsapp.${action}`, `${who}: ${message}`);
  revalidatePath("/agentes/vendedor");
  return { ok: true, state: await loadWhatsappPanelState({ includeQr: true }), message };
}

/** Atualização periódica da tela. O QR só sai para quem pode conectar. */
export async function refreshWhatsappPanel(): Promise<WhatsappPanelState> {
  const user = await getCurrentUser();
  return loadWhatsappPanelState({ includeQr: canAdminister(user.role) });
}

export async function connectWhatsapp(): Promise<WhatsappActionResult> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: ADMIN_DENIED };
  return run("connect", admin.name);
}

export async function disconnectWhatsapp(): Promise<WhatsappActionResult> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: ADMIN_DENIED };
  return run("disconnect", admin.name);
}

/** Apaga a sessão no gateway: o próximo uso exige ler o QR Code de novo. */
export async function logoutWhatsapp(): Promise<WhatsappActionResult> {
  const admin = await getAdminUser();
  if (!admin) return { ok: false, error: ADMIN_DENIED };
  return run("logout", admin.name);
}
