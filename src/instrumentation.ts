/**
 * Roda uma vez quando o servidor sobe. Aqui nasce o runner dos agentes: ele
 * vive no mesmo processo do Next porque o estado do CRM (snapshot e cache de
 * leads) é por processo — um segundo processo teria o seu próprio e
 * sobrescreveria o do servidor.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
