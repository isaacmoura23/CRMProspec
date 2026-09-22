import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { buildGmailAuthUrl, gmailConfigProblem, gmailRedirectUri } from "@/providers/email/gmail";

export const dynamic = "force-dynamic";

/** Inicia o OAuth do Gmail. O `state` fica em cookie httpOnly e é conferido no callback (CSRF). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  const problem = gmailConfigProblem();
  if (problem) return NextResponse.redirect(new URL(`/carreira?aba=candidaturas&gmail=erro&motivo=${encodeURIComponent(problem)}`, req.url));

  const state = crypto.randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("career_gmail_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return NextResponse.redirect(buildGmailAuthUrl(state, gmailRedirectUri(req.nextUrl.origin)));
}
