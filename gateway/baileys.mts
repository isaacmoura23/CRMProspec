import { Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeWASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import type { SocketFactory, WaSocketLike } from "./session.mjs";

/**
 * Fábrica do socket real (Baileys). Fica isolada para o resto do gateway ser
 * testável sem rede nem WhatsApp.
 */
export function createBaileysFactory(opts: { logLevel?: string } = {}): SocketFactory {
  const logger = pino({ level: opts.logLevel ?? process.env.BAILEYS_LOG_LEVEL ?? "silent" });

  return async ({ state }) => {
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));
    const sock = makeWASocket({
      version,
      logger,
      browser: Browsers.ubuntu("AtlasCode"),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      markOnlineOnConnect: false,
      // Número dedicado à prospecção: não há histórico a importar, e importar
      // só traria conversas antigas para dentro do funil.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
    });
    return sock as unknown as WaSocketLike;
  };
}
