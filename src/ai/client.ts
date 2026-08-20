import "server-only";

/**
 * Cliente LLM.
 * Usa a OpenAI API quando OPENAI_API_KEY está configurada.
 * Sem chave, retorna null e o chamador usa o engine determinístico
 * (src/ai/engine.ts) como fallback — o produto continua 100% funcional.
 */

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function llmModelName(): string {
  return isLlmConfigured() ? `openai/${MODEL}` : "engine/deterministic-v1";
}

export async function llmComplete(
  system: string,
  user: string,
  opts: { json?: boolean; temperature?: number } = {}
): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: opts.temperature ?? 0.7,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      console.error(`[ai] OpenAI respondeu ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("[ai] falha ao chamar OpenAI:", err);
    return null;
  }
}
