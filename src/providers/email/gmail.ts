import "server-only";
import { decryptJson, encryptJson, isTokenSecretConfigured } from "@/lib/crypto";
import { isValidEmail } from "@/lib/job-text";
import { base64Url, buildMimeMessage } from "@/lib/mime";
import type { EmailChannel, OutgoingEmail, SendOutcome } from "@/providers/email/types";
import type { ProviderConnection } from "@/types/career";

/**
 * Gmail — canal opcional que envia pela conta do próprio candidato.
 *
 * OAuth 2.0 com escopo mínimo `gmail.send` (+ `openid email` para saber
 * qual conta foi conectada). Tokens ficam cifrados no banco
 * (CAREER_TOKEN_SECRET) e são renovados pelo refresh token; revogação
 * chama o endpoint oficial. Guia: https://developers.google.com/workspace/gmail/api/guides/sending
 *
 * Respostas recebidas NÃO são sincronizadas: isso exigiria escopo de
 * leitura e outra integração. O status de seleção é atualizado à mão.
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];

const TIMEOUT_MS = 20_000;

export interface GmailTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // epoch ms
}

export function gmailConfigProblem(): string | null {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) return "GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET não definidos.";
  if (!isTokenSecretConfigured()) return "CAREER_TOKEN_SECRET (≥ 16 caracteres) é necessário para guardar tokens cifrados.";
  return null;
}

export function isGmailOAuthConfigured(): boolean {
  return gmailConfigProblem() === null;
}

export function gmailRedirectUri(origin: string): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${origin}/api/career/gmail/callback`;
}

export function buildGmailAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeGmailCode(code: string, redirectUri: string): Promise<{ tokens: GmailTokens; email: string; scopes: string[] }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? "Falha ao trocar o código OAuth");
  const scopes = (data.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.send")) throw new Error("A permissão de envio (gmail.send) não foi concedida.");

  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${data.access_token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const profile = (await info.json()) as { email?: string };
  if (!profile.email) throw new Error("Não foi possível identificar o e-mail da conta Google.");

  return {
    tokens: { access_token: data.access_token, refresh_token: data.refresh_token ?? null, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 },
    email: profile.email,
    scopes,
  };
}

async function refreshTokens(tokens: GmailTokens): Promise<GmailTokens> {
  if (!tokens.refresh_token) throw new Error("Sem refresh token: reconecte a conta Gmail.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description ?? data.error ?? "Falha ao renovar o token");
    (err as Error & { revoked?: boolean }).revoked = data.error === "invalid_grant";
    throw err;
  }
  return { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

export async function revokeGmailTokens(connection: ProviderConnection): Promise<void> {
  try {
    const tokens = decryptJson<GmailTokens>(connection.encrypted_tokens);
    const token = tokens.refresh_token ?? tokens.access_token;
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    /* já revogado ou indisponível — a conexão é removida de qualquer forma */
  }
}

export function encryptGmailTokens(tokens: GmailTokens): string {
  return encryptJson(tokens);
}

/**
 * Canal ligado a uma conexão específica. `persist` grava os tokens
 * renovados de volta na conexão.
 */
export class GmailChannel implements EmailChannel {
  id = "gmail" as const;
  name = "Gmail";

  constructor(
    private connection: ProviderConnection,
    private persist: (patch: Partial<ProviderConnection>) => Promise<void>
  ) {}

  isConfigured() {
    return isGmailOAuthConfigured() && this.connection.status === "ativa";
  }

  private async accessToken(): Promise<string> {
    let tokens = decryptJson<GmailTokens>(this.connection.encrypted_tokens);
    if (tokens.expires_at - Date.now() < 60_000) {
      try {
        tokens = await refreshTokens(tokens);
      } catch (err) {
        if ((err as { revoked?: boolean }).revoked) {
          await this.persist({ status: "revogada", updated_at: new Date().toISOString() });
        }
        throw err;
      }
      await this.persist({ encrypted_tokens: encryptGmailTokens(tokens), expires_at: new Date(tokens.expires_at).toISOString(), updated_at: new Date().toISOString() });
    }
    return tokens.access_token;
  }

  async send(email: OutgoingEmail): Promise<SendOutcome> {
    if (!this.isConfigured()) return { kind: "rejected", error: "Conta Gmail não conectada ou permissão revogada.", permanent: true };
    if (!isValidEmail(email.to)) return { kind: "rejected", error: "Destinatário inválido", permanent: true };

    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      return { kind: "rejected", error: err instanceof Error ? err.message : "Falha de autenticação no Gmail", permanent: true };
    }

    const domain = this.connection.account_email.split("@")[1] ?? "prospecatlas.local";
    const raw = buildMimeMessage({
      from: this.connection.account_email,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      replyTo: null, // a resposta já cai na própria conta
      messageId: `${email.idempotencyKey}@${domain}`,
      attachment: { filename: email.attachment.filename, content: email.attachment.content, contentType: "application/pdf" },
      extraHeaders: { "X-ProspecAtlas-Application": email.applicationId },
    });

    let res: Response;
    try {
      res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: base64Url(raw) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Sem escopo de leitura não dá para procurar a mensagem depois: fica incerto até revisão manual.
      return { kind: "uncertain", error: err instanceof Error ? err.message : "Erro de rede" };
    }
    if (res.status === 429) return { kind: "rate_limited", retryAfterMs: 60_000 };
    let data: { id?: string; error?: { message?: string; status?: string } } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      /* sem corpo */
    }
    if (res.ok && data.id) return { kind: "accepted", providerMessageId: data.id };
    const message = data.error?.message ?? `Gmail respondeu ${res.status}`;
    if (res.status === 401 || res.status === 403) await this.persist({ status: "revogada", updated_at: new Date().toISOString() });
    return { kind: "rejected", error: message, permanent: res.status < 500 };
  }
}
