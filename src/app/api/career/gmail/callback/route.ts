import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { uid } from "@/lib/utils";
import { encryptGmailTokens, exchangeGmailCode, gmailRedirectUri } from "@/providers/email/gmail";
import { careerRepo } from "@/services/career/repository";
import { ownerOf } from "@/services/career/service";
import type { ProviderConnection } from "@/types/career";

export const dynamic = "force-dynamic";

function back(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/carreira", req.url);
  url.searchParams.set("aba", "candidaturas");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const jar = await cookies();
  const expected = jar.get("career_gmail_state")?.value;
  jar.delete("career_gmail_state");
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  if (error) return back(req, { gmail: "erro", motivo: error });
  if (!code || !state || !expected || state !== expected) return back(req, { gmail: "erro", motivo: "state inválido" });

  try {
    const { tokens, email, scopes } = await exchangeGmailCode(code, gmailRedirectUri(req.nextUrl.origin));
    const owner = ownerOf(user);
    const repo = careerRepo();
    const now = new Date().toISOString();
    const existing = (await repo.list(owner, "connections", { provider: "gmail" }))[0];
    const row: ProviderConnection = {
      id: existing?.id ?? uid("conn"),
      owner_id: owner.owner_id,
      organization_id: owner.organization_id,
      provider: "gmail",
      account_email: email,
      encrypted_tokens: encryptGmailTokens(tokens),
      scopes,
      expires_at: new Date(tokens.expires_at).toISOString(),
      status: "ativa",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) await repo.update(owner, "connections", existing.id, row);
    else await repo.insert("connections", row);
    return back(req, { gmail: "ok" });
  } catch (err) {
    return back(req, { gmail: "erro", motivo: err instanceof Error ? err.message : "falha" });
  }
}
