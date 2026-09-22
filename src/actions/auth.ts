"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/store";
import { clearSession, setSessionUser } from "@/lib/auth";
import { createSessionClient, isSupabaseAuthConfigured } from "@/lib/supabase-auth";

/**
 * Ações de autenticação.
 *
 * Com Supabase Auth configurado: e-mail/senha, link mágico e recuperação de
 * senha. Sem ele, o login demo por seleção de usuário continua valendo.
 *
 * As mensagens de erro são deliberadamente genéricas em "credenciais
 * inválidas": diferenciar "e-mail não existe" de "senha errada" entrega a
 * lista de quem tem conta a quem estiver testando.
 */

export type AuthResult = { ok: true; message?: string; next?: string } | { ok: false; error: string };

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const passwordSchema = z.string().min(8, "A senha precisa de pelo menos 8 caracteres.").max(200);

/** Quem nunca configurou a empresa cai no onboarding, como no modo demo. */
function destinationAfterLogin(): string {
  return getDb().onboarding_completed ? "/dashboard" : "/onboarding";
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/* ---------------- Modo demo ---------------- */

export async function loginAs(userId: string): Promise<void> {
  if (isSupabaseAuthConfigured()) return; // login demo desativado em produção
  const db = getDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  await setSessionUser(userId);
  redirect(db.onboarding_completed ? "/dashboard" : "/onboarding");
}

/* ---------------- Supabase Auth ---------------- */

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success || typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "Informe e-mail e senha." };
  }
  const supabase = await createSessionClient();
  if (!supabase) return { ok: false, error: "Autenticação não configurada no servidor." };

  const { error } = await supabase.auth.signInWithPassword({ email: parsedEmail.data, password });
  if (error) {
    if (error.message.toLowerCase().includes("email not confirmed")) {
      return { ok: false, error: "Confirme seu e-mail pelo link que enviamos antes de entrar." };
    }
    return { ok: false, error: "E-mail ou senha incorretos." };
  }
  revalidatePath("/", "layout");
  return { ok: true, next: destinationAfterLogin() };
}

export async function signUpWithPassword(name: string, email: string, password: string): Promise<AuthResult> {
  const parsedEmail = emailSchema.safeParse(email);
  const parsedPassword = passwordSchema.safeParse(password);
  const parsedName = z.string().trim().min(2).max(120).safeParse(name);
  if (!parsedEmail.success) return { ok: false, error: "Informe um e-mail válido." };
  if (!parsedName.success) return { ok: false, error: "Informe seu nome." };
  if (!parsedPassword.success) return { ok: false, error: parsedPassword.error.issues[0]?.message ?? "Senha inválida." };

  const supabase = await createSessionClient();
  if (!supabase) return { ok: false, error: "Autenticação não configurada no servidor." };

  const { data, error } = await supabase.auth.signUp({
    email: parsedEmail.data,
    password: parsedPassword.data,
    // O papel NÃO vai aqui: quem decide é o banco (convite, primeira conta ou
    // viewer). Metadados do cadastro são entrada do cliente.
    options: { data: { name: parsedName.data }, emailRedirectTo: `${await origin()}/auth/callback` },
  });
  if (error) {
    if (error.message.toLowerCase().includes("already registered")) {
      return { ok: false, error: "Já existe uma conta com este e-mail. Entre ou recupere a senha." };
    }
    return { ok: false, error: error.message };
  }
  // Sem sessão na resposta = o projeto exige confirmação por e-mail.
  if (!data.session) {
    return { ok: true, message: "Conta criada. Confirme o e-mail pelo link que enviamos para entrar." };
  }
  revalidatePath("/", "layout");
  return { ok: true, next: destinationAfterLogin() };
}

export async function sendMagicLink(email: string): Promise<AuthResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "Informe um e-mail válido." };
  const supabase = await createSessionClient();
  if (!supabase) return { ok: false, error: "Autenticação não configurada no servidor." };
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: `${await origin()}/auth/callback`, shouldCreateUser: true },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, message: "Link enviado. Confira sua caixa de entrada." };
}

export async function sendPasswordReset(email: string): Promise<AuthResult> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: "Informe um e-mail válido." };
  const supabase = await createSessionClient();
  if (!supabase) return { ok: false, error: "Autenticação não configurada no servidor." };
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${await origin()}/auth/callback?proximo=/conta/senha`,
  });
  // Mesma resposta exista ou não a conta: a tela não confirma quem é cadastrado.
  if (error) console.error("[auth] reset de senha:", error.message);
  return { ok: true, message: "Se existir uma conta com este e-mail, o link de redefinição chegou nela." };
}

export async function updatePassword(password: string): Promise<AuthResult> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Senha inválida." };
  const supabase = await createSessionClient();
  if (!supabase) return { ok: false, error: "Autenticação não configurada no servidor." };
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: "Sessão expirada. Peça um novo link de redefinição." };
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { ok: false, error: error.message };
  return { ok: true, message: "Senha atualizada." };
}

export async function logout(): Promise<void> {
  const supabase = await createSessionClient();
  if (supabase) await supabase.auth.signOut();
  await clearSession();
  redirect("/login");
}
