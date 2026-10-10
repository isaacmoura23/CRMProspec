import { startAgentRunner } from "@/services/agents/runner";

const started = startAgentRunner();
if (!started.started) {
  console.info(`[agentes] runner não iniciado: ${started.reason}`);
}
