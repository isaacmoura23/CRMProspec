/**
 * Gateway do WhatsApp (dispositivo vinculado por QR Code) do AtlasCode AgentOS.
 *
 * Serviço SEPARADO do site, sempre ligado. Mantém a conexão persistente com o
 * WhatsApp pela biblioteca não oficial Baileys (o mesmo protocolo do WhatsApp
 * Web) — NÃO é a API oficial da Meta; leia docs/WHATSAPP_LOCAL.md antes de
 * ativar envios reais.
 *
 * Portado do gateway da Cobra. Diferenças: guarda a sessão num SQLite próprio
 * (não acessa o banco do CRM), entrega os eventos ao CRM por webhook assinado a
 * partir de uma caixa de saída durável, e só envia de verdade com a autorização
 * de envio emitida pelo CRM (política, aprovação, limites).
 *
 * Uso:  npm run gateway     (variáveis em .env.gateway; ver .env.gateway.example)
 */
import { loadConfig } from "./config.mjs";
import { createBaileysFactory } from "./baileys.mjs";
import { createSimulatedFactory, injectSimulatedMessage } from "./simulated.mjs";
import { OutboxDispatcher } from "./outbox.mjs";
import { createGatewayServer } from "./server.mjs";
import { SessionManager } from "./session.mjs";
import { GatewayStore } from "./store.mjs";

// Node lê o arquivo de variáveis sem dependência extra. Ausente é normal
// (as variáveis podem vir do ambiente).
try {
  process.loadEnvFile(".env.gateway");
} catch {
  /* sem .env.gateway */
}

const log = (msg: string, extra?: Record<string, unknown>) => {
  console.log(`[gateway] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
};

async function main() {
  const config = loadConfig();
  const store = new GatewayStore(config.dbFile);

  const dispatcher =
    config.webhookUrl && config.webhookSecret
      ? new OutboxDispatcher({ store, url: config.webhookUrl, secret: config.webhookSecret, log })
      : null;

  const manager = new SessionManager({
    store,
    factory: config.simulate ? createSimulatedFactory() : createBaileysFactory(),
    emit: (event) => {
      store.enqueue({ id: event.id, session_id: event.session_id, type: event.type, payload: JSON.stringify(event) });
      // Tenta já, sem esperar o próximo ciclo; se falhar, a caixa de saída segura.
      void dispatcher?.tick();
    },
    dryRun: config.dryRun,
    forwardMessages: config.forwardMessages,
    forwardDelivery: config.forwardDelivery,
    qrWaitMaxMs: config.qrWaitMaxMs,
    sendSecret: config.webhookSecret,
    allowedRecipients: config.allowedRecipients,
    log,
  });

  const server = createGatewayServer({
    manager,
    store,
    token: config.token,
    dryRun: config.dryRun,
    simulateInbound: config.simulate ? (sessionId, body) => injectSimulatedMessage(sessionId, body) : undefined,
    log,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  const restored = await manager.restorePaired();
  dispatcher?.start();

  const sending = config.allowedRecipients.length > 0
    ? `TESTE RESTRITO: só ${config.allowedRecipients.length} número(s) da lista recebem envio real; os demais são simulados`
    : config.dryRun
      ? "MODO DE TESTE (nenhuma mensagem será enviada)"
      : "ENVIO REAL ligado (exige a autorização de envio do CRM)";
  log(`iniciado: ${sending}`, {
    url: `http://${config.host}:${config.port}`,
    sessoesRestauradas: restored.length,
    entregaAoCrm: config.webhookUrl ?? "desligada (eventos ficam retidos)",
    mensagens: config.forwardMessages ? "entregues ao CRM" : "não entregues",
    estadoDeEntrega: config.forwardDelivery ? "entregue ao CRM" : "não entregue",
  });
  if (config.simulate) log("SIMULADO: sessão e números são de mentira; nada sai do computador (GATEWAY_SIMULATE=1).");
  if (!config.dryRun && config.allowedRecipients.length === 0 && !config.simulate) {
    log("ATENÇÃO: o modo de teste está desligado e não há lista de destinatários: mensagens autorizadas pelo CRM saem de verdade para qualquer número.");
  }
  if (!config.webhookSecret) log("Sem WHATSAPP_WEBHOOK_SECRET: o envio real fica indisponível (não há como validar a autorização do CRM).");

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log("encerrando");
    dispatcher?.stop();
    server.close();
    await manager.shutdown();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(`[gateway] não iniciou: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
