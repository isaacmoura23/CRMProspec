import type { Metadata } from "next";
import { Target } from "lucide-react";
import { getDb } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/auth";
import { loginAs } from "@/actions/auth";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = { title: "Entrar" };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const db = getDb();
  const supabase = isSupabaseConfigured();

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary">
            <Target className="size-6 text-white" strokeWidth={2.5} />
          </span>
          <div>
            <h1 className="text-xl font-semibold text-white">
              Prospec<span className="text-primary">Atlas</span>
            </h1>
            <p className="mt-1 text-[13px] text-sidebar-fg">
              Encontre quem deveria ser seu próximo cliente.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-surface p-6 shadow-pop">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Entrar</h2>
            <Badge variant={supabase ? "good" : "neutral"}>
              {supabase ? "Supabase Auth" : "Modo demo"}
            </Badge>
          </div>

          {!supabase && (
            <p className="mb-4 text-[13px] text-muted-foreground">
              Sem credenciais do Supabase configuradas, entre com um dos usuários de
              demonstração:
            </p>
          )}

          <div className="space-y-2">
            {db.users.map((user) => (
              <form key={user.id} action={loginAs.bind(null, user.id)}>
                <button
                  type="submit"
                  className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-all hover:border-primary/50 hover:shadow-card cursor-pointer"
                >
                  <Avatar name={user.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{user.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
                  </span>
                  <Badge variant="neutral" className="capitalize">
                    {user.role}
                  </Badge>
                </button>
              </form>
            ))}
          </div>

          <p className="mt-4 border-t border-border pt-4 text-center text-[11px] text-faint-foreground">
            Em produção, defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY
            para ativar login por e-mail/senha com Supabase Auth.
          </p>
        </div>
      </div>
    </div>
  );
}
