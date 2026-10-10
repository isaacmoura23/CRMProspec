import "server-only";

/**
 * Cliente LLM.
 * Usa a API da Anthropic quando ANTHROPIC_API_KEY está configurada, ou a da
 * OpenAI quando OPENAI_API_KEY está. Sem chave, retorna null e o chamador usa o
 * engine determinístico (src/ai/engine.ts) como fallback — o produto continua
 * 100% funcional.
 */

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const ANTHROPIC_VERSION = "2023-06-01";

type Provider = "anthropic" | "openai" | null;

function activeProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function isLlmConfigured(): boolean {
  return activeProvider() !== null;
}

export function llmModelName(): string {
  const p = activeProvider();
  if (p === "anthropic") return `anthropic/${ANTHROPIC_MODEL}`;
  if (p === "openai") return `openai/${OPENAI_MODEL}`;
  return "engine/deterministic-v1";
}

/** Modelos às vezes embrulham o JSON em cercas de código; o chamador valida o resultado de qualquer jeito. */
function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1]! : text.trim();
}

async function completeAnthropic(system: string, user: string, opts: { json?: boolean; temperature?: number }): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      temperature: opts.temperature ?? 0.7,
      system: opts.json ? `${system}\n\nResponda somente com um objeto JSON válido, sem texto antes ou depois.` : system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    console.error(`[ai] Anthropic respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  return opts.json ? stripFences(text) : text;
}

async function completeOpenAi(system: string, user: string, opts: { json?: boolean; temperature?: number }): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
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
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? null;
}

export async function llmComplete(
  system: string,
  user: string,
  opts: { json?: boolean; temperature?: number } = {}
): Promise<string | null> {
  const provider = activeProvider();
  if (!provider) return null;
  try {
    return provider === "anthropic" ? await completeAnthropic(system, user, opts) : await completeOpenAi(system, user, opts);
  } catch (err) {
    console.error(`[ai] falha ao chamar ${provider}:`, err);
    return null;
  }
}
