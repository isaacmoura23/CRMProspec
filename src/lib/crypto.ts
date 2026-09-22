import crypto from "node:crypto";

/**
 * Cifra simétrica para tokens OAuth guardados no banco (AES-256-GCM).
 * A chave vem de CAREER_TOKEN_SECRET; sem ela, conexões que dependem de
 * token (Gmail) ficam indisponíveis — nunca gravamos token em claro.
 */

function keyFrom(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function isTokenSecretConfigured(): boolean {
  return (process.env.CAREER_TOKEN_SECRET ?? "").length >= 16;
}

export function encryptJson(value: unknown, secret = process.env.CAREER_TOKEN_SECRET ?? ""): string {
  if (secret.length < 16) throw new Error("CAREER_TOKEN_SECRET ausente ou curto demais (mínimo 16 caracteres)");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptJson<T = unknown>(payload: string, secret = process.env.CAREER_TOKEN_SECRET ?? ""): T {
  const [v, ivB, tagB, dataB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || !dataB) throw new Error("Payload cifrado inválido");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]);
  return JSON.parse(plain.toString("utf-8")) as T;
}

/**
 * Verificação de assinatura no padrão Svix (usado pelos webhooks do Resend).
 * Cabeçalhos: svix-id, svix-timestamp, svix-signature ("v1,<base64> v1,<base64>").
 * Conteúdo assinado: `${id}.${timestamp}.${corpo bruto}` com HMAC-SHA256 da
 * chave (o segredo `whsec_<base64>` decodificado).
 */
export function verifySvixSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  toleranceSeconds = 300,
  now = Date.now()
): { ok: true } | { ok: false; reason: string } {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "Cabeçalhos de assinatura ausentes" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "Timestamp inválido" };
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return { ok: false, reason: "Timestamp fora da tolerância (replay?)" };

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  const provided = headers.signature
    .split(/\s+/)
    .map((part) => part.split(",")[1])
    .filter((s): s is string => Boolean(s));
  for (const sig of provided) {
    let buf: Buffer;
    try {
      buf = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (buf.length === expected.length && crypto.timingSafeEqual(buf, expected)) return { ok: true };
  }
  return { ok: false, reason: "Assinatura não confere" };
}
