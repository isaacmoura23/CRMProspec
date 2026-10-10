import type { SocketFactory, WaSocketLike } from "./session.mjs";

/**
 * Socket SIMULADO, só para desenvolvimento (`GATEWAY_SIMULATE=1`).
 *
 * Conecta na hora, sem QR e sem WhatsApp, "envia" devolvendo um id inventado e
 * simula o ciclo enviado → entregue → lido. Nada sai do computador. Serve para
 * exercitar a tela, a política de envio, as aprovações e a caixa de saída ponta
 * a ponta sem um número de verdade — com o código real do gateway por cima
 * (autorização, lista de destinatários, idempotência, eventos).
 *
 * Números terminados em "0000" simulam "não tem WhatsApp".
 */

type Handler = (...args: unknown[]) => void;

class SimulatedSocket implements WaSocketLike {
  private handlers = new Map<string, Handler[]>();
  private counter = 0;
  user: { id: string; name?: string };

  ev = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
  };

  constructor(phone: string) {
    this.user = { id: `${phone}:1@s.whatsapp.net`, name: "Número simulado" };
  }

  private emit(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }

  open() {
    setTimeout(() => this.emit("connection.update", { connection: "open" }), 50);
  }

  end() {}
  async logout() {}

  async onWhatsApp(...phones: string[]) {
    return phones.map((p) => ({ exists: !p.endsWith("0000"), jid: `${p}@s.whatsapp.net` }));
  }

  async sendMessage() {
    const id = `SIM${Date.now().toString(36)}${(this.counter++).toString(36)}`.toUpperCase();
    // Enviado → entregue → lido, como o WhatsApp confirmaria.
    for (const [delay, status] of [[600, 2], [1_800, 3], [4_500, 4]] as const) {
      setTimeout(() => this.emit("messages.update", [{ key: { id, fromMe: true }, update: { status } }]), delay);
    }
    return { key: { id } };
  }
}

export function createSimulatedFactory(phone = process.env.GATEWAY_SIMULATE_PHONE ?? "5500000000000"): SocketFactory {
  return async () => {
    const sock = new SimulatedSocket(phone);
    sock.open();
    return sock;
  };
}
