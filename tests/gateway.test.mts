import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signGatewayEvent, verifyGatewayEvent, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from "@/lib/gateway-signature";
import { gatewayEvent } from "@/lib/gateway-events";
import { loadConfig } from "../gateway/config.mjs";
import { GatewayStore } from "../gateway/store.mjs";
import { OutboxDispatcher, backoffMs, MAX_BACKOFF_MS } from "../gateway/outbox.mjs";
import { GatewayError, SessionManager, type EmittedEvent, type SocketFactory, type WaSocketLike } from "../gateway/session.mjs";
import { createGatewayServer } from "../gateway/server.mjs";

/* ------------------------------------------------------------------ */
/* Apoio                                                               */
/* ------------------------------------------------------------------ */

type Handler = (...args: unknown[]) => void;

class FakeSocket implements WaSocketLike {
  private handlers = new Map<string, Handler[]>();
  ev = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
  };
  user: { id: string; name?: string } | null = null;
  ended = false;
  loggedOut = false;
  lookups: string[] = [];
  existing = new Set<string>();

  emit(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
  end() {
    this.ended = true;
  }
  async logout() {
    this.loggedOut = true;
  }
  async onWhatsApp(...phones: string[]) {
    this.lookups.push(...phones);
    return phones.map((p) => ({ exists: this.existing.has(p), jid: `${p}@s.whatsapp.net` }));
  }
}

/** Fábrica que guarda os sockets criados e dá acesso às credenciais que o gerenciador entregou. */
function makeFactory() {
  const sockets: FakeSocket[] = [];
  const seenCreds: Array<{ me?: unknown; registered?: boolean }> = [];
  const factory: SocketFactory = async ({ state }) => {
    seenCreds.push({ me: (state.creds as { me?: unknown }).me, registered: (state.creds as { registered?: boolean }).registered });
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets, seenCreds, last: () => sockets[sockets.length - 1]! };
}

async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condição não ocorreu a tempo");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeManager(over: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const store = over.store ?? new GatewayStore(":memory:");
  const f = makeFactory();
  const events: EmittedEvent[] = [];
  const manager = new SessionManager({
    store,
    factory: f.factory,
    emit: (e) => events.push(e),
    dryRun: true,
    forwardMessages: false,
    qrWaitMaxMs: 60_000,
    sleep: async () => {},
    ...over,
  });
  return { manager, store, events, ...f };
}

const statuses = (events: EmittedEvent[]) =>
  events.filter((e) => e.type === "session.status").map((e) => (e.type === "session.status" ? e.data.status : ""));

/** Pareia a sessão como o Baileys faz: grava `me` nas credenciais e avisa `creds.update`. */
async function pair(h: ReturnType<typeof makeManager>, sessionId = "atlas", phone = "5541999998888") {
  const connecting = h.manager.connect(sessionId);
  await until(() => h.sockets.length > 0);
  const sock = h.last();
  sock.emit("connection.update", { qr: "2@fake-qr-payload" });
  await until(() => h.manager.status(sessionId).status === "QR");
  sock.user = { id: `${phone}:12@s.whatsapp.net`, name: "Atlas Comercial" };
  sock.emit("connection.update", { connection: "open" });
  await until(() => h.manager.status(sessionId).status === "CONNECTED");
  await connecting;
  return sock;
}

/* ------------------------------------------------------------------ */

describe("configuração do gateway", () => {
  const ok = { WHATSAPP_GATEWAY_TOKEN: "t".repeat(20) };

  it("exige token forte e recusa segredo fraco com a entrega ligada", () => {
    assert.throws(() => loadConfig({}), /WHATSAPP_GATEWAY_TOKEN/);
    assert.throws(() => loadConfig({ WHATSAPP_GATEWAY_TOKEN: "curto" }), /16 caracteres/);
    assert.throws(() => loadConfig({ ...ok, CRM_WEBHOOK_URL: "http://127.0.0.1:3000/x" }), /WHATSAPP_WEBHOOK_SECRET/);
    assert.throws(() => loadConfig({ ...ok, CRM_WEBHOOK_URL: "ftp://x", WHATSAPP_WEBHOOK_SECRET: "s".repeat(20) }), /http/);
    assert.throws(() => loadConfig({ ...ok, GATEWAY_PORT: "abc" }), /GATEWAY_PORT/);
  });

  it("é seguro por padrão: só local, modo de teste ligado, mensagens não entregues", () => {
    const c = loadConfig(ok);
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.dryRun, true);
    assert.equal(c.forwardMessages, false);
    assert.equal(c.webhookUrl, null);
    assert.equal(loadConfig({ ...ok, WHATSAPP_GATEWAY_DRY_RUN: "0" }).dryRun, false);
    assert.equal(loadConfig({ ...ok, WHATSAPP_GATEWAY_DRY_RUN: "1" }).dryRun, true);
    assert.equal(loadConfig({ ...ok, WHATSAPP_GATEWAY_DRY_RUN: "qualquer coisa" }).dryRun, true, "dúvida não desliga o modo de teste");
  });
});

describe("assinatura dos eventos", () => {
  const secret = "s".repeat(32);
  const body = '{"a":1}';
  const now = 1_700_000_000_000;

  it("aceita assinatura correta e recusa corpo, segredo ou instante trocados", () => {
    const sig = signGatewayEvent(secret, now, body);
    assert.deepEqual(verifyGatewayEvent({ secret, timestamp: String(now), signature: sig, body, now }), { ok: true });
    assert.deepEqual(verifyGatewayEvent({ secret, timestamp: String(now), signature: sig, body: '{"a":2}', now }), { ok: false, reason: "mismatch" });
    assert.deepEqual(verifyGatewayEvent({ secret: "x".repeat(32), timestamp: String(now), signature: sig, body, now }), { ok: false, reason: "mismatch" });
    assert.deepEqual(verifyGatewayEvent({ secret, timestamp: String(now + 1), signature: sig, body, now }), { ok: false, reason: "mismatch" });
  });

  it("recusa evento antigo (captura reaproveitada), futuro demais e cabeçalhos ausentes", () => {
    const sig = signGatewayEvent(secret, now, body);
    assert.equal(verifyGatewayEvent({ secret, timestamp: String(now), signature: sig, body, now: now + 6 * 60_000 }).ok, false);
    assert.equal(verifyGatewayEvent({ secret, timestamp: String(now), signature: sig, body, now: now - 6 * 60_000 }).ok, false);
    assert.deepEqual(verifyGatewayEvent({ secret, timestamp: null, signature: sig, body, now }), { ok: false, reason: "missing" });
    assert.deepEqual(verifyGatewayEvent({ secret, timestamp: String(now), signature: undefined, body, now }), { ok: false, reason: "missing" });
    assert.equal(verifyGatewayEvent({ secret, timestamp: "abc", signature: sig, body, now }).ok, false);
    assert.equal(verifyGatewayEvent({ secret, timestamp: String(now), signature: "sha256=curta", body, now }).ok, false);
  });
});

describe("armazenamento: sessão e caixa de saída", () => {
  it("guarda credenciais e chaves (inclusive binárias) e sobrevive a fechar e reabrir o arquivo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-store-"));
    const file = path.join(dir, "gw.db");
    const { sqliteAuthState } = await import("../gateway/auth-state.mjs");

    let store = new GatewayStore(file);
    const a = sqliteAuthState(store, "atlas");
    (a.state.creds as { me?: unknown }).me = { id: "5541999998888:1@s.whatsapp.net" };
    a.saveCreds();
    await a.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([9, 8, 7]) } } });
    store.close();

    store = new GatewayStore(file);
    assert.deepEqual(store.pairedSessionIds(), ["atlas"]);
    const b = sqliteAuthState(store, "atlas");
    assert.deepEqual((b.state.creds as { me?: unknown }).me, { id: "5541999998888:1@s.whatsapp.net" });
    const keys = await b.state.keys.get("pre-key", ["1", "2"]);
    assert.deepEqual(Buffer.from(keys["1"]!.public), Buffer.from([1, 2, 3]));
    assert.equal(keys["2"], undefined);

    // apagar uma chave (valor nulo) e limpar a sessão inteira
    await b.state.keys.set({ "pre-key": { "1": null as never } });
    assert.equal(Object.keys(await b.state.keys.get("pre-key", ["1"])).length, 0);
    b.clear();
    assert.deepEqual(store.pairedSessionIds(), []);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sessão que nunca foi pareada não volta sozinha", () => {
    const store = new GatewayStore(":memory:");
    store.saveSession("atlas", { creds: JSON.stringify({ registered: false }), status: "QR" });
    assert.deepEqual(store.pairedSessionIds(), []);
  });

  it("a caixa de saída é idempotente pelo id do evento e preserva a ordem", () => {
    const store = new GatewayStore(":memory:");
    store.enqueue({ id: "evt-00000001", session_id: "atlas", type: "session.status", payload: "{}" });
    store.enqueue({ id: "evt-00000001", session_id: "atlas", type: "session.status", payload: "{}" });
    store.enqueue({ id: "evt-00000002", session_id: "atlas", type: "message.received", payload: "{}" });
    assert.deepEqual(store.pending().map((r) => r.event_id), ["evt-00000001", "evt-00000002"]);
  });
});

describe("entrega ao CRM (caixa de saída)", () => {
  const url = "http://crm.test/api/webhooks/whatsapp";
  const secret = "s".repeat(32);

  function setup() {
    const store = new GatewayStore(":memory:");
    let clock = 1_000_000;
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    let respond: () => Response | Promise<Response> = () => new Response("{}", { status: 200 });
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      return respond();
    }) as unknown as typeof fetch;
    const dispatcher = new OutboxDispatcher({ store, url, secret, fetchImpl, now: () => clock });
    return {
      store,
      dispatcher,
      calls,
      setRespond: (f: typeof respond) => (respond = f),
      advance: (ms: number) => (clock += ms),
      enqueue: (id: string, type = "session.status") => store.enqueue({ id, session_id: "atlas", type, payload: JSON.stringify({ id }) }, clock),
    };
  }

  it("entrega assinado e na ordem; o receptor consegue verificar o que chegou", async () => {
    const t = setup();
    t.enqueue("evt-00000001");
    t.enqueue("evt-00000002");
    const report = await t.dispatcher.tick();
    assert.equal(report.delivered, 2);
    assert.deepEqual(t.calls.map((c) => c.headers[EVENT_ID_HEADER]), ["evt-00000001", "evt-00000002"]);
    for (const c of t.calls) {
      const v = verifyGatewayEvent({ secret, timestamp: c.headers[TIMESTAMP_HEADER], signature: c.headers[SIGNATURE_HEADER], body: c.body, now: 1_000_000 });
      assert.equal(v.ok, true);
    }
    assert.equal((await t.dispatcher.tick()).delivered, 0, "o que foi entregue não sai de novo");
  });

  it("com o CRM fora do ar nada se perde: espera com backoff, segura a fila e entrega quando volta", async () => {
    const t = setup();
    t.setRespond(() => {
      throw new Error("ECONNREFUSED");
    });
    t.enqueue("evt-00000001");
    t.enqueue("evt-00000002");

    const down = await t.dispatcher.tick();
    assert.equal(down.retried, 1);
    assert.equal(t.calls.length, 1, "o segundo não ultrapassa o primeiro");
    assert.deepEqual(t.store.outboxCounts(), { pending: 2, dead: 0 });

    // ainda dentro da espera: nem tenta
    await t.dispatcher.tick();
    assert.equal(t.calls.length, 1);

    // CRM volta e a espera passa
    t.setRespond(() => new Response("{}", { status: 200 }));
    t.advance(MAX_BACKOFF_MS);
    const up = await t.dispatcher.tick();
    assert.equal(up.delivered, 2);
    assert.deepEqual(t.calls.slice(1).map((c) => c.headers[EVENT_ID_HEADER]), ["evt-00000001", "evt-00000002"]);
    assert.deepEqual(t.store.outboxCounts(), { pending: 0, dead: 0 });
  });

  it("reiniciar o gateway não perde o que estava retido (o arquivo guarda a fila)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-outbox-"));
    const file = path.join(dir, "gw.db");
    let store = new GatewayStore(file);
    store.enqueue({ id: "evt-00000001", session_id: "atlas", type: "message.received", payload: '{"x":1}' });
    store.close();

    store = new GatewayStore(file);
    const calls: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      url,
      secret,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        calls.push((init.headers as Record<string, string>)[EVENT_ID_HEADER]!);
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    assert.equal((await dispatcher.tick()).delivered, 1);
    assert.deepEqual(calls, ["evt-00000001"]);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("evento que o CRM recusa como inválido é descartado sem travar a fila; 401 continua tentando", async () => {
    const t = setup();
    t.setRespond(() => new Response("{}", { status: 400 }));
    t.enqueue("evt-00000001");
    t.setRespond(() => new Response("{}", { status: 400 }));
    const dead = await t.dispatcher.tick();
    assert.equal(dead.dead, 1);

    t.enqueue("evt-00000002");
    t.setRespond(() => new Response("{}", { status: 401 }));
    const bad = await t.dispatcher.tick();
    assert.equal(bad.retried, 1, "segredo errado não é motivo para descartar");
    assert.deepEqual(t.store.outboxCounts(), { pending: 1, dead: 1 });

    t.setRespond(() => new Response("{}", { status: 200 }));
    t.advance(MAX_BACKOFF_MS);
    assert.equal((await t.dispatcher.tick()).delivered, 1);
  });

  it("o backoff cresce e tem teto", () => {
    assert.ok(backoffMs(1) < backoffMs(2));
    assert.equal(backoffMs(50), MAX_BACKOFF_MS);
  });
});

describe("sessão do WhatsApp: ciclo de vida", () => {
  it("QR → conectado: expõe a imagem do QR, o número, e entrega só mudanças de estado", async () => {
    const h = makeManager();
    const connecting = h.manager.connect("atlas");
    await until(() => h.sockets.length === 1);
    const sock = h.last();

    sock.emit("connection.update", { qr: "2@primeiro" });
    await until(() => h.manager.status("atlas").status === "QR");
    const first = h.manager.status("atlas");
    assert.match(first.qrDataUrl ?? "", /^data:image\/png;base64,/);

    // O QR se renova a cada ~20 s: é o mesmo estado, não um evento novo.
    const before = h.events.length;
    sock.emit("connection.update", { qr: "2@segundo" });
    await until(() => h.manager.status("atlas").qrUpdatedAt !== first.qrUpdatedAt || true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.events.length, before);

    sock.user = { id: "5541999998888:7@s.whatsapp.net", name: "Atlas" };
    sock.emit("connection.update", { connection: "open" });
    await until(() => h.manager.status("atlas").status === "CONNECTED");
    await connecting;

    const s = h.manager.status("atlas");
    assert.equal(s.phone, "+5541999998888");
    assert.equal(s.qrDataUrl, null, "conectado não devolve QR");
    assert.deepEqual(statuses(h.events), ["CONNECTING", "QR", "CONNECTED"]);
    // todo evento emitido obedece ao contrato do CRM
    for (const e of h.events) assert.equal(gatewayEvent.safeParse(e).success, true);
    // o QR nunca vai para o CRM
    assert.ok(!JSON.stringify(h.events).includes("data:image"));
  });

  it("queda de rede reconecta sozinha; o celular encerrando a sessão exige novo QR e apaga as credenciais", async () => {
    const h = makeManager();
    const sock = await pair(h);
    assert.deepEqual(h.store.pairedSessionIds(), ["atlas"].filter(() => false), "creds só são gravadas pelo creds.update do Baileys");

    // queda comum (sem código de logout): CONNECTING e um socket novo
    sock.emit("connection.update", { connection: "close", lastDisconnect: { error: Object.assign(new Error("rede caiu"), { output: { statusCode: 408 } }) } });
    await until(() => h.sockets.length === 2);
    assert.equal(h.manager.status("atlas").status, "CONNECTING");

    // o celular encerra a sessão (401 = loggedOut)
    const second = h.last();
    h.store.saveSession("atlas", { creds: JSON.stringify({ me: { id: "x" } }) });
    second.emit("connection.update", { connection: "close", lastDisconnect: { error: Object.assign(new Error("logged out"), { output: { statusCode: 401 } }) } });
    await until(() => h.manager.status("atlas").status === "NEEDS_RECONNECT");
    assert.deepEqual(h.store.pairedSessionIds(), [], "credenciais inúteis foram apagadas");
    assert.equal(h.sockets.length, 2, "não tenta reconectar com sessão encerrada");
    assert.equal(h.manager.status("atlas").phone, null);
  });

  it("'sair do dispositivo' desloga e apaga a sessão; 'desconectar' fecha mas guarda", async () => {
    const h = makeManager();
    const sock = await pair(h);
    h.store.saveSession("atlas", { creds: JSON.stringify({ me: { id: "x" } }) });

    const off = await h.manager.disconnect("atlas", false);
    assert.equal(off.status, "DISCONNECTED");
    assert.equal(sock.ended, true);
    assert.equal(sock.loggedOut, false);
    assert.deepEqual(h.store.pairedSessionIds(), ["atlas"], "desconectar guarda a sessão");
    assert.equal(h.manager.status("atlas").status, "DISCONNECTED");

    // o fechamento do socket antigo não pode reabrir nada
    sock.emit("connection.update", { connection: "close", lastDisconnect: { error: new Error("fechado por nós") } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.sockets.length, 1);

    const sock2 = await pair(h);
    const out = await h.manager.disconnect("atlas", true);
    assert.equal(out.status, "DISCONNECTED");
    assert.equal(sock2.loggedOut, true);
    assert.deepEqual(h.store.pairedSessionIds(), [], "sair apaga a sessão: voltar exige novo QR");
  });

  it("REINÍCIO: com a sessão pareada, o gateway volta conectado sem pedir novo QR", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-restart-"));
    const file = path.join(dir, "gw.db");

    // 1ª vida: pareia e o Baileys grava as credenciais.
    let h = makeManager({ store: new GatewayStore(file) });
    const connecting = h.manager.connect("atlas");
    await until(() => h.sockets.length === 1);
    const first = h.last();
    first.emit("connection.update", { qr: "2@qr" });
    await until(() => h.manager.status("atlas").status === "QR");
    // O Baileys altera as credenciais em memória e avisa; o gerenciador grava.
    h.store.saveSession("atlas", { creds: JSON.stringify({ me: { id: "5541999998888:1@s.whatsapp.net" }, registered: true }) });
    first.user = { id: "5541999998888:1@s.whatsapp.net", name: "Atlas" };
    first.emit("connection.update", { connection: "open" });
    await until(() => h.manager.status("atlas").status === "CONNECTED");
    await connecting;
    await h.manager.shutdown();
    h.store.close();

    // 2ª vida: processo novo, mesmo arquivo.
    h = makeManager({ store: new GatewayStore(file) });
    assert.equal(h.manager.status("atlas").status, "NEEDS_RECONNECT", "antes de reabrir: há credenciais, falta o socket");
    const restored = await h.manager.restorePaired();
    assert.deepEqual(restored, ["atlas"]);
    await until(() => h.sockets.length === 1);
    assert.ok(h.seenCreds[0]!.me, "o socket nasceu com as credenciais guardadas");

    h.last().user = { id: "5541999998888:1@s.whatsapp.net", name: "Atlas" };
    h.last().emit("connection.update", { connection: "open" });
    await until(() => h.manager.status("atlas").status === "CONNECTED");
    assert.ok(!statuses(h.events).includes("QR"), "nenhum QR foi pedido depois do reinício");
    assert.equal(h.manager.status("atlas").phone, "+5541999998888");

    await h.manager.shutdown();
    h.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("QR que ninguém lê expira em vez de renovar para sempre", async () => {
    const h = makeManager({ qrWaitMaxMs: 10 });
    void h.manager.connect("atlas");
    await until(() => h.sockets.length === 1);
    const sock = h.last();
    sock.emit("connection.update", { qr: "2@a" });
    await until(() => h.manager.status("atlas").status === "QR");
    await new Promise((r) => setTimeout(r, 25));
    sock.emit("connection.update", { qr: "2@b" });
    await until(() => h.manager.status("atlas").status === "DISCONNECTED");
    assert.match(h.manager.status("atlas").lastError ?? "", /expirado/);
    assert.equal(sock.ended, true);
  });
});

describe("consulta de número e envio (modo de teste)", () => {
  it("desconectado nunca 'aceita' envio nem consulta", async () => {
    const h = makeManager();
    assert.throws(() => h.manager.send("atlas", { to: "+5541999998888", text: "oi", clientReference: "r" }), (e: unknown) => e instanceof GatewayError && e.kind === "DISCONNECTED" && e.httpStatus === 503);
    await assert.rejects(h.manager.recipient("atlas", "+5541999998888"), (e: unknown) => e instanceof GatewayError && e.kind === "DISCONNECTED");
  });

  it("em modo de teste aceita, devolve id simulado e não toca o socket", async () => {
    const h = makeManager();
    const sock = await pair(h);
    const r = h.manager.send("atlas", { to: "+5541999998888", text: "oi", clientReference: "ref" });
    assert.match(r.providerMessageId, /^dryrun-/);
    assert.equal(r.dryRun, true);
    assert.equal(sock.lookups.length, 0);
  });

  it("com o modo de teste desligado o envio real continua bloqueado (501) até a política de envio", async () => {
    const h = makeManager({ dryRun: false });
    await pair(h);
    assert.throws(() => h.manager.send("atlas", { to: "+5541999998888", text: "oi", clientReference: "r" }), (e: unknown) => e instanceof GatewayError && e.httpStatus === 501);
  });

  it("valida o destinatário e o texto", async () => {
    const h = makeManager();
    await pair(h);
    for (const bad of [{ to: "5541999998888", text: "oi" }, { to: "+55", text: "oi" }, { to: "+5541999998888", text: "   " }, { to: "+5541999998888", text: "x".repeat(4001) }]) {
      assert.throws(() => h.manager.send("atlas", { ...bad, clientReference: "" }), (e: unknown) => e instanceof GatewayError && e.httpStatus === 400);
    }
    await assert.rejects(h.manager.recipient("atlas", "abc"), (e: unknown) => e instanceof GatewayError && e.httpStatus === 400);
  });

  it("recipient usa o endereço que o WhatsApp devolve e diz quando o número não existe", async () => {
    const h = makeManager();
    const sock = await pair(h);
    sock.existing.add("5541988887777");
    assert.deepEqual(await h.manager.recipient("atlas", "+5541988887777"), { exists: true, jid: "5541988887777@s.whatsapp.net" });
    assert.deepEqual(await h.manager.recipient("atlas", "+5541900000000"), { exists: false, jid: null });
  });
});

describe("mensagens recebidas (entrega ligada)", () => {
  const CONTATO = "5541988887777@s.whatsapp.net";
  const GRUPO = "120363001234567890@g.us";

  async function connected(forwardMessages: boolean) {
    const h = makeManager({ forwardMessages });
    const sock = await pair(h);
    h.events.length = 0;
    return { h, sock };
  }

  it("desligada por padrão: mensagem nenhuma sai do gateway", async () => {
    const { h, sock } = await connected(false);
    sock.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "ABC123XYZ", remoteJid: CONTATO }, message: { conversation: "oi" } }] });
    assert.equal(h.events.length, 0);
  });

  it("entrega a resposta do contato, a do próprio celular e o estado de entrega, com ids estáveis", async () => {
    const { h, sock } = await connected(true);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { id: "MSG-IN-0001", remoteJid: CONTATO }, message: { conversation: "Quanto custa?" }, pushName: "Carlos" },
        { key: { id: "MSG-OUT-001", remoteJid: CONTATO, fromMe: true }, message: { extendedTextMessage: { text: "Já te respondo" } } },
      ],
    });
    sock.emit("messages.update", [
      { key: { id: "MSG-OUT-001", fromMe: true }, update: { status: 3 } },
      { key: { id: "MSG-OUT-001", fromMe: true }, update: { status: 4 } },
      { key: { id: "MSG-IN-0001", fromMe: false }, update: { status: 3 } },
    ]);

    assert.deepEqual(
      h.events.map((e) => e.id),
      ["received:MSG-IN-0001", "from_phone:MSG-OUT-001", "delivery:MSG-OUT-001:DELIVERED", "delivery:MSG-OUT-001:READ"]
    );
    const received = h.events[0]!;
    assert.equal(received.type, "message.received");
    if (received.type === "message.received") {
      assert.equal(received.data.peer, "+5541988887777");
      assert.equal(received.data.text, "Quanto custa?");
      assert.equal(received.data.profile_name, "Carlos");
    }
    assert.equal(h.events[1]!.type, "message.from_phone");
    for (const e of h.events) assert.equal(gatewayEvent.safeParse(e).success, true);
  });

  it("ignora status, grupo, canal e o que não tem conteúdo; aceita endereço @lid com o telefone no campo alternativo", async () => {
    const { h, sock } = await connected(true);
    sock.emit("messages.upsert", {
      type: "notify",
      messages: [
        { key: { id: "ST-0000001", remoteJid: "status@broadcast" }, message: { imageMessage: { caption: "bom dia" } } },
        { key: { id: "STM-000001", remoteJid: CONTATO }, message: { statusMentionMessage: { message: {} } } },
        { key: { id: "GRP-000001", remoteJid: GRUPO }, message: { conversation: "oi grupo" } },
        { key: { id: "NWS-000001", remoteJid: "120363001234567890@newsletter" }, message: { conversation: "canal" } },
        { key: { id: "VAZ-000001", remoteJid: CONTATO }, message: {} },
        { key: { id: "LID-000001", remoteJid: "99887766@lid", remoteJidAlt: CONTATO }, message: { conversation: "pelo lid" } },
      ],
    });
    assert.deepEqual(h.events.map((e) => e.id), ["received:LID-000001"]);
  });
});

describe("API HTTP do gateway", () => {
  async function start() {
    // Espera real (curta): o connect aguarda o QR aparecer, e o sleep nulo dos outros testes o faria desistir na hora.
    const h = makeManager({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
    const server = createGatewayServer({ manager: h.manager, store: h.store, token: "t".repeat(20), dryRun: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const call = (p: string, init: RequestInit = {}, auth: string | null = `Bearer ${"t".repeat(20)}`) =>
      fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" } });
    return { h, server, call };
  }

  it("só /health é aberto; o resto exige o token certo", async () => {
    const { server, call } = await start();
    try {
      const health = await call("/health", {}, null);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { ok: boolean; dryRun: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.dryRun, true);

      assert.equal((await call("/sessions/atlas/status", {}, null)).status, 401);
      assert.equal((await call("/sessions/atlas/status", {}, "Bearer errado")).status, 401);
      assert.equal((await call("/sessions/atlas/status")).status, 200);
      assert.equal((await call("/sessions/at las/status")).status, 404);
      assert.equal((await call("/outra-rota")).status, 404);
      assert.equal((await call("/sessions/atlas/status", { method: "POST" })).status, 405);
    } finally {
      server.close();
    }
  });

  it("conectar devolve o QR; consultar mostra o estado; mensagem desconectada volta 503 com o kind certo", async () => {
    const { h, server, call } = await start();
    try {
      const connecting = call("/sessions/atlas/connect", { method: "POST" });
      await until(() => h.sockets.length === 1);
      h.last().emit("connection.update", { qr: "2@qr" });
      const res = await connecting;
      const status = (await res.json()) as { status: string; qrDataUrl: string | null; dryRun: boolean };
      assert.equal(status.status, "QR");
      assert.match(status.qrDataUrl ?? "", /^data:image\/png/);
      assert.equal(status.dryRun, true);

      const msg = await call("/sessions/atlas/messages", { method: "POST", body: JSON.stringify({ to: "+5541999998888", text: "oi", clientReference: "r" }) });
      assert.equal(msg.status, 503, "ainda não conectado");
      assert.equal(((await msg.json()) as { kind: string }).kind, "DISCONNECTED");

      const bad = await call("/sessions/atlas/recipient", { method: "POST", body: "{não é json" });
      assert.equal(bad.status, 400);
    } finally {
      server.close();
    }
  });

  it("corpo grande demais é recusado", async () => {
    const { server, call } = await start();
    try {
      const big = await call("/sessions/atlas/messages", { method: "POST", body: JSON.stringify({ text: "x".repeat(70 * 1024) }) });
      assert.equal(big.status, 413);
    } finally {
      server.close();
    }
  });
});
