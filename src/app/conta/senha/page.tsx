import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { getSessionUser, isSupabaseConfigured } from "@/lib/auth";
import { NewPasswordForm } from "@/features/auth/new-password-form";

export const metadata: Metadata = { title: "Definir senha" };
export const dynamic = "force-dynamic";

/**
 * Destino do link de redefinição: o callback já trocou o token por sessão,
 * então aqui o visitante está autenticado e só falta escolher a senha.
 */
export default async function NovaSenhaPage() {
  if (!isSupabaseConfigured()) redirect("/login");
  const user = await getSessionUser();
  if (!user) redirect("/login?erro=" + encodeURIComponent("O link expirou. Peça outro."));

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-surface p-6 shadow-pop">
        <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary-soft">
          <KeyRound className="size-5 text-primary" />
        </span>
        <h1 className="text-sm font-semibold">Definir nova senha</h1>
        <p className="mb-4 mt-0.5 text-[13px] text-muted-foreground">
          Conta: {user.email}
        </p>
        <NewPasswordForm />
      </div>
    </div>
  );
}
