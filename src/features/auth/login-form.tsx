"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, sendPasswordReset, signInWithPassword, signUpWithPassword, type AuthResult } from "@/actions/auth";
import { cn } from "@/lib/utils";

type Mode = "entrar" | "criar" | "link" | "recuperar";

const TITLES: Record<Mode, { title: string; cta: string }> = {
  entrar: { title: "Entrar", cta: "Entrar" },
  criar: { title: "Criar conta", cta: "Criar conta" },
  link: { title: "Entrar por link", cta: "Enviar link" },
  recuperar: { title: "Recuperar senha", cta: "Enviar link de redefinição" },
};

export function LoginForm({ initialError, next }: { initialError: string | null; next: string }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>("entrar");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(initialError);
  const [message, setMessage] = React.useState<string | null>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);

  // Foco pelo cliente, não por `autoFocus`: em SSR o React marca o campo com
  // `caret-color: transparent` até hidratar, e o atributo extra no HTML do
  // servidor gera aviso de hidratação.
  React.useEffect(() => {
    emailRef.current?.focus();
  }, []);

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setMessage(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    let result: AuthResult;
    try {
      if (mode === "entrar") result = await signInWithPassword(email, password);
      else if (mode === "criar") result = await signUpWithPassword(name, email, password);
      else if (mode === "link") result = await sendMagicLink(email);
      else result = await sendPasswordReset(email);
    } catch {
      result = { ok: false, error: "Não conseguimos falar com o servidor. Tente novamente." };
    }
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.message) {
      setMessage(result.message);
      return;
    }
    // Sessão criada: o destino vem do servidor (onboarding na primeira vez),
    // a menos que o visitante tenha sido mandado ao login vindo de uma página.
    router.replace(next !== "/dashboard" ? next : (result.next ?? next));
    router.refresh();
  }

  const needsPassword = mode === "entrar" || mode === "criar";

  return (
    <form onSubmit={submit} className="space-y-3">
      {mode === "criar" && (
        <div className="space-y-1.5">
          <Label htmlFor="auth-name">Nome</Label>
          <Input id="auth-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="auth-email">E-mail</Label>
        <Input ref={emailRef} id="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>

      {needsPassword && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="auth-password">Senha</Label>
            {mode === "entrar" && (
              <button type="button" onClick={() => switchTo("recuperar")} className="text-xs text-primary hover:underline cursor-pointer">
                Esqueci a senha
              </button>
            )}
          </div>
          <Input
            id="auth-password"
            type="password"
            autoComplete={mode === "criar" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "criar" ? 8 : undefined}
            aria-describedby={mode === "criar" ? "auth-password-hint" : undefined}
          />
          {mode === "criar" && (
            <p id="auth-password-hint" className="text-xs text-muted-foreground">Mínimo de 8 caracteres.</p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
        </p>
      )}
      {message && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-primary-soft px-3 py-2 text-[13px] text-primary-soft-fg">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {message}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : mode === "link" || mode === "recuperar" ? <Mail /> : null}
        {TITLES[mode].cta}
      </Button>

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
        {mode !== "entrar" && (
          <button type="button" onClick={() => switchTo("entrar")} className={link}>
            Entrar com senha
          </button>
        )}
        {mode !== "criar" && (
          <button type="button" onClick={() => switchTo("criar")} className={link}>
            Criar conta
          </button>
        )}
        {mode !== "link" && (
          <button type="button" onClick={() => switchTo("link")} className={link}>
            Entrar por link no e-mail
          </button>
        )}
      </div>
    </form>
  );
}

const link = cn("text-primary hover:underline cursor-pointer");
