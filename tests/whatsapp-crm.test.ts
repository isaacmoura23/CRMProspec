import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { signGatewayEvent, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from "@/lib/gateway-signature";
import { ProviderError } from "@/providers/whatsapp/types";
import { QrGatewayWhatsAppProvider } from "@/providers/whatsapp/qr-gateway";
import { agentRepo, getAgentData, resetAgentRepoForTests } from "@/services/agents/repository";
import { housekeeping } from "@/services/agents/runner";
import { sanitizeSessionId, whatsappGatewayConfig, whatsappWebhookSecret } from "@/services/whatsapp/config";
import { getWhatsappLink } from "@/services/whatsapp/link";
import { loadWhatsappPanelState } from "@/services/whatsapp/panel";
import { handleGatewayWebhook } from "@/services/whatsapp/webhook";
import { emptyAgentData } from "@/types/agents";
import { GatewayStore } from "../gateway/store.mjs";
import { OutboxDispatcher, MAX_BACKOFF_MS } from "../gateway/outbox.mjs";

const SECRET = "s".repeat(40);
const SESSION = "org_atlas";

function reset() {
  resetAgentRepoForTests();
  Object.assign(getAgentData(), emptyAgentData());
}

function configure() {
  process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
  process.env.WHATSAPP_GATEWAY_URL = "http://gateway.test";
  process.env.WHATSAPP_GATEWAY_TOKEN = "t".repeat(24);
  delete process.env.WHATSAPP_SESSION_ID;
}

function unconfigure() {
  delete process.env.WHATSAPP_WEBHOOK_SECRET;
  delete process.env.WHATSAPP_GATEWAY_URL;
  delete process.env.WHATSAPP_GATEWAY_TOKEN;
}

const sessionEvent = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  id: `evt-${Math.random().toString(16).slice(2, 12)}`,
  type: "session.status",
  session_id: SESSION,
  occurred_at: new Date().toISOString(),
  data: { status: "CONNECTED", phone: "+5541999998888", push_name: "Atlas", last_error: null, dry_run: true, ...dataOver },
  ...over,
});

/** Monta a requisição como o gateway a monta: corpo bruto + cabeçalhos assinados. */
function signed(event: object, opts: { secret?: string; timestamp?: number; tamper?: boolean } = {}) {
  const raw = JSON.stringify(event);
  const timestamp = opts.timestamp ?? Date.now();
  const headers = new Headers({
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signGatewayEvent(opts.secret ?? SECRET, timestamp, raw),
    [EVENT_ID_HEADER]: (event as { id: string }).id,
  });
  return { rawBody: opts.tamper ? raw.replace("CONNECTED", "DISCONNECTED") : raw, headers };
}

describe("webhook do gateway (CRM)", () => {
  beforeEach(() => {
    reset();
    configure();
  });
  afterEach(unconfigure);

  it("sem segredo configurado recusa tudo (503) e não grava nada", async () => {
    delete process.env.WHATSAPP_WEBHOOK_SECRET;
    const res = await handleGatewayWebhook(signed(sessionEvent()));
    assert.equal(res.status, 503);
    assert.equal(await getWhatsappLink(), null);
    process.env.WHATSAPP_WEBHOOK_SECRET = "curto";
    assert.equal(whatsappWebhookSecret(), null, "segredo curto equivale a ausente");
  });

  it("recusa assinatura errada, corpo adulterado, evento antigo e requisição sem cabeçalhos", async () => {
    const e = sessionEvent();
    assert.equal((await handleGatewayWebhook(signed(e, { secret: "x".repeat(40) }))).status, 401);
    assert.equal((await handleGatewayWebhook(signed(e, { tamper: true }))).status, 401);
    assert.equal((await handleGatewayWebhook(signed(e, { timestamp: Date.now() - 10 * 60_000 }))).status, 401);
    assert.equal((await handleGatewayWebhook({ rawBody: JSON.stringify(e), headers: new Headers() })).status, 401);
    assert.equal(await getWhatsappLink(), null, "nada vazou para o estado");
    assert.equal(getAgentData().whatsapp_receipts.length, 0);
  });

  it("evento válido atualiza o estado, registra recibo e entra no log", async () => {
    const e = sessionEvent();
    const res = await handleGatewayWebhook(signed(e));
    assert.equal(res.status, 200);
    const link = (await getWhatsappLink())!;
    assert.equal(link.status, "CONNECTED");
    assert.equal(link.phone, "+5541999998888");
    assert.equal(link.dry_run, true);
    assert.equal(getAgentData().whatsapp_receipts.length, 1);
    assert.ok(getAgentData().events.some((x) => x.type === "whatsapp.status" && /conectado/.test(x.message)));
  });

  it("o gateway reenvia até confirmarmos: o mesmo evento duas vezes tem efeito uma só vez", async () => {
    const e = sessionEvent();
    assert.equal((await handleGatewayWebhook(signed(e))).status, 200);
    const eventsAfterFirst = getAgentData().events.length;
    const again = await handleGatewayWebhook(signed(e));
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(getAgentData().whatsapp_receipts.length, 1);
    assert.equal(getAgentData().events.length, eventsAfterFirst, "o duplicado não repete o efeito");
  });

  it("evento mais antigo que chega depois não desfaz o estado mais novo", async () => {
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date().toISOString();
    await handleGatewayWebhook(signed(sessionEvent({ occurred_at: t2 }, { status: "CONNECTED" })));
    const late = await handleGatewayWebhook(signed(sessionEvent({ occurred_at: t1 }, { status: "QR", phone: null })));
    assert.equal(late.status, 200, "confirma para o gateway parar de reenviar");
    const link = (await getWhatsappLink())!;
    assert.equal(link.status, "CONNECTED");
    assert.equal(link.last_event_at, t2);
  });

  it("recusa evento malformado, tipo desconhecido, JSON inválido e id diferente do cabeçalho (400)", async () => {
    assert.equal((await handleGatewayWebhook(signed({ ...sessionEvent(), data: { status: "INVENTADO" } }))).status, 400);
    assert.equal((await handleGatewayWebhook(signed({ ...sessionEvent(), type: "bot.takeover" }))).status, 400);
    assert.equal((await handleGatewayWebhook(signed({ ...sessionEvent(), session_id: "id com espaço" }))).status, 400);

    const raw = "{isto não é json";
    const ts = Date.now();
    const bad = await handleGatewayWebhook({
      rawBody: raw,
      headers: new Headers({ [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signGatewayEvent(SECRET, ts, raw) }),
    });
    assert.equal(bad.status, 400);

    const ok = signed(sessionEvent());
    ok.headers.set(EVENT_ID_HEADER, "outro-id-qualquer");
    assert.equal((await handleGatewayWebhook(ok)).status, 400);
    assert.equal(getAgentData().whatsapp_receipts.length, 0);
  });

  it("mensagem de número que não é de nenhum lead é confirmada (recibo gravado) e ignorada", async () => {
    const msg = {
      id: "received:ABCDEF123",
      type: "message.received",
      session_id: SESSION,
      occurred_at: new Date().toISOString(),
      data: { provider_message_id: "ABCDEF123", peer: "+5541988887777", text: "oi", media_type: null, profile_name: null },
    };
    const res = await handleGatewayWebhook(signed(msg));
    assert.equal(res.status, 200);
    assert.equal(getAgentData().whatsapp_receipts.length, 1);
    assert.ok(getAgentData().events.some((x) => x.type === "conversation.unknown"));
  });

  it("só mudança de estado vira log: o mesmo estado repetido não enche o registro", async () => {
    await handleGatewayWebhook(signed(sessionEvent({}, { status: "QR", phone: null })));
    await handleGatewayWebhook(signed(sessionEvent({ occurred_at: new Date(Date.now() + 1000).toISOString() }, { status: "QR", phone: null })));
    await handleGatewayWebhook(signed(sessionEvent({ occurred_at: new Date(Date.now() + 2000).toISOString() }, { status: "NEEDS_RECONNECT", phone: null })));
    const logs = getAgentData().events.filter((x) => x.type === "whatsapp.status");
    assert.equal(logs.length, 2);
    assert.equal(logs[1]!.level, "warn", "precisa reconectar é aviso");
  });

  it("a limpeza remove recibos antigos e mantém os recentes", async () => {
    const org = (await import("@/lib/store")).getDb().organization.id;
    const repo = agentRepo();
    await repo.insert("whatsapp_receipts", { id: "old", organization_id: org, type: "session.status", received_at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    await repo.insert("whatsapp_receipts", { id: "new", organization_id: org, type: "session.status", received_at: new Date().toISOString() });
    await housekeeping();
    assert.deepEqual((await repo.list("whatsapp_receipts")).map((r) => r.id), ["new"]);
  });
});

describe("configuração no CRM", () => {
  afterEach(unconfigure);

  it("sem URL e token o recurso não existe; o id da sessão é saneado para o formato do gateway", () => {
    unconfigure();
    assert.equal(whatsappGatewayConfig(), null);
    configure();
    const cfg = whatsappGatewayConfig()!;
    assert.equal(cfg.sessionId, "org_atlas");
    assert.equal(sanitizeSessionId("org atlas/ç!"), "org_atlas___");
    assert.equal(sanitizeSessionId("a".repeat(100)).length, 64);
    assert.equal(sanitizeSessionId(""), "atlas");
  });
});

describe("cliente do gateway", () => {
  const provider = new QrGatewayWhatsAppProvider("http://gateway.test", "test-token", "org_atlas", "w".repeat(40));
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });
  const stub = (res: () => Response | Promise<Response>) => {
    globalThis.fetch = (async () => res()) as unknown as typeof fetch;
  };

  it("resposta simulada do modo de teste não é tratada como envio", async () => {
    for (const body of [{ providerMessageId: "dryrun-123", dryRun: true }, { providerMessageId: "dryrun-legado" }]) {
      stub(() => new Response(JSON.stringify(body)));
      await assert.rejects(provider.sendText({ to: "+5585999999999", body: "oi", clientReference: "ref" }), (e: unknown) => e instanceof ProviderError && e.kind === "DRY_RUN" && !e.retryable);
    }
  });

  it("aceita identificação de envio real", async () => {
    stub(() => new Response(JSON.stringify({ providerMessageId: "3EB0ABC" })));
    assert.deepEqual(await provider.sendText({ to: "+5585999999999", body: "oi", clientReference: "ref" }), { providerMessageId: "3EB0ABC" });
  });

  it("traduz os erros do gateway nos tipos que a política de envio entende", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [503, { error: "WhatsApp desconectado", kind: "DISCONNECTED" }, "DISCONNECTED"],
      [401, { error: "não autorizado", kind: "AUTH" }, "AUTH"],
      [422, { error: "Número não encontrado", kind: "INVALID_RECIPIENT" }, "INVALID_RECIPIENT"],
      [500, {}, "TEMPORARY"],
      [400, {}, "PERMANENT"],
    ];
    for (const [status, body, kind] of cases) {
      stub(() => new Response(JSON.stringify(body), { status }));
      await assert.rejects(provider.status(), (e: unknown) => e instanceof ProviderError && e.kind === kind, `status ${status}`);
    }
  });

  it("gateway inacessível vira erro transitório; timeout vira envio incerto (nunca reenviar sozinho)", async () => {
    stub(() => {
      throw new Error("ECONNREFUSED");
    });
    await assert.rejects(provider.status(), (e: unknown) => e instanceof ProviderError && e.kind === "TEMPORARY" && e.retryable);
    stub(() => {
      throw Object.assign(new Error("tempo"), { name: "TimeoutError" });
    });
    await assert.rejects(provider.sendText({ to: "+5585999999999", body: "oi", clientReference: "r" }), (e: unknown) => e instanceof ProviderError && e.uncertain);
  });

  it("monta as rotas e o token certos", async () => {
    const calls: Array<{ url: string; auth: string | null; method: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, method: init.method ?? "GET" });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await provider.status();
    await provider.connect();
    await provider.disconnect(false);
    await provider.disconnect(true);
    await provider.health();
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "GET http://gateway.test/sessions/org_atlas/status",
        "POST http://gateway.test/sessions/org_atlas/connect",
        "POST http://gateway.test/sessions/org_atlas/disconnect",
        "POST http://gateway.test/sessions/org_atlas/logout",
        "GET http://gateway.test/health",
      ]
    );
    assert.ok(calls.every((c) => c.auth === "Bearer test-token"));
  });
});

describe("estado da tela de conexão", () => {
  beforeEach(reset);
  afterEach(() => {
    unconfigure();
  });
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("sem gateway configurado não há o que mostrar", async () => {
    unconfigure();
    const s = await loadWhatsappPanelState({ includeQr: true });
    assert.equal(s.configured, false);
    assert.equal(s.reachable, false);
  });

  it("gateway fora do ar: diz como resolver e mostra o último estado que o CRM recebeu", async () => {
    configure();
    await handleGatewayWebhook(signed(sessionEvent()));
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const s = await loadWhatsappPanelState({ includeQr: true });
    assert.equal(s.reachable, false);
    assert.match(s.error ?? "", /npm run gateway/);
    assert.equal(s.link?.status, "CONNECTED");
  });

  it("o QR só chega a quem pode conectar", async () => {
    configure();
    globalThis.fetch = (async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/health")
            ? { ok: true, dryRun: true, sessions: [], outbox: { pending: 2, dead: 0 } }
            : { status: "QR", phone: null, pushName: null, qrDataUrl: "data:image/png;base64,AAAA", qrUpdatedAt: null, lastError: null, dryRun: true }
        )
      )) as unknown as typeof fetch;
    const admin = await loadWhatsappPanelState({ includeQr: true });
    const viewer = await loadWhatsappPanelState({ includeQr: false });
    assert.equal(admin.status?.qrDataUrl, "data:image/png;base64,AAAA");
    assert.equal(viewer.status?.qrDataUrl, null);
    assert.equal(viewer.status?.status, "QR");
    assert.deepEqual(admin.outbox, { pending: 2, dead: 0 });
  });
});

describe("gateway → CRM de ponta a ponta (caixa de saída real)", () => {
  beforeEach(() => {
    reset();
    configure();
  });
  afterEach(unconfigure);

  it("com o CRM fora do ar os eventos esperam; ao voltar, chegam na ordem e sem duplicar, mesmo reenviados", async () => {
    const store = new GatewayStore(":memory:");
    let clock = Date.now();
    let crmUp = false;
    let deliveries = 0;

    // O "CRM" é o tratador real; só a rede é simulada.
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (!crmUp) throw new Error("ECONNREFUSED");
      deliveries += 1;
      const headers = new Headers(init.headers as Record<string, string>);
      const res = await handleGatewayWebhook({ rawBody: String(init.body), headers, now: clock });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof fetch;
    const dispatcher = new OutboxDispatcher({ store, url: "http://crm/api/webhooks/whatsapp", secret: SECRET, fetchImpl, now: () => clock });

    const t = (n: number) => new Date(clock + n).toISOString();
    const events = [
      sessionEvent({ id: "evt-aaaaaaaa", occurred_at: t(0) }, { status: "QR", phone: null }),
      sessionEvent({ id: "evt-bbbbbbbb", occurred_at: t(1000) }, { status: "CONNECTED" }),
    ];
    for (const e of events) store.enqueue({ id: e.id, session_id: SESSION, type: e.type, payload: JSON.stringify(e) }, clock);

    // CRM derrubado: nada chega, nada se perde.
    await dispatcher.tick();
    assert.equal(await getWhatsappLink(), null);
    assert.equal(store.outboxCounts().pending, 2);

    // CRM volta e a espera do backoff passa.
    crmUp = true;
    clock += MAX_BACKOFF_MS;
    await dispatcher.tick();
    assert.equal(store.outboxCounts().pending, 0);
    assert.equal((await getWhatsappLink())!.status, "CONNECTED", "o último estado vale");

    // O gateway reenvia por engano (ex.: confirmação perdida): o efeito não se repete.
    const logsBefore = getAgentData().events.length;
    store.enqueue({ id: "evt-aaaaaaaa", session_id: SESSION, type: "session.status", payload: JSON.stringify(events[0]) }, clock);
    assert.equal(store.pending().length, 0, "o mesmo id não entra de novo na caixa de saída");
    // e, se o duplicado chegar ao CRM por outro caminho, ele só confirma:
    const direct = await handleGatewayWebhook(signed(events[0]!, { timestamp: clock }));
    assert.equal(direct.body.duplicate, true);
    assert.equal(getAgentData().events.length, logsBefore);
    assert.equal(getAgentData().whatsapp_receipts.length, 2);
    assert.ok(deliveries >= 2);
    store.close();
  });
});
