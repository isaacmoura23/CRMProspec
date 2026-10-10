import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { GatewayStore } from "./store.mjs";

/**
 * Estado de autenticação do Baileys no SQLite do gateway (uma sessão por
 * `sessionId`). Espelha o `useMultiFileAuthState` oficial e o
 * `postgresAuthState` da Cobra, mas sem depender de pastas soltas nem de
 * servidor de banco: sobrevive a reinício e uma cópia do arquivo é um backup.
 */
export function sqliteAuthState(
  store: GatewayStore,
  sessionId: string
): { state: AuthenticationState; saveCreds: () => void; clear: () => void } {
  const row = store.getSession(sessionId);
  const creds: AuthenticationCreds = row?.creds
    ? (JSON.parse(row.creds, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const found = store.getKeys(sessionId, type, ids);
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const [id, raw] of found) {
            let value = JSON.parse(raw, BufferJSON.reviver) as SignalDataTypeMap[T];
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          const entries: Array<{ category: string; id: string; value: string | null }> = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const values = data[category] ?? {};
            for (const id of Object.keys(values)) {
              const value = values[id];
              entries.push({ category, id, value: value ? JSON.stringify(value, BufferJSON.replacer) : null });
            }
          }
          store.setKeys(sessionId, entries);
        },
      },
    },
    saveCreds: () => {
      store.saveSession(sessionId, { creds: JSON.stringify(creds, BufferJSON.replacer) });
    },
    clear: () => store.clearSession(sessionId),
  };
}
