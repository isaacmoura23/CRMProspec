"use client";

import * as React from "react";
import { Loader2, MapPin, Plug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { testGooglePlaces, type ConnectionTest } from "@/actions/integrations";

/**
 * Card do Google Places com verificação real.
 *
 * A presença da variável de ambiente só diz que alguém a preencheu; quem
 * confirma a conexão é uma chamada de verdade à API.
 */
export function GooglePlacesCard({ hasKey }: { hasKey: boolean }) {
  const { toast } = useToast();
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ConnectionTest | null>(null);

  async function run() {
    setTesting(true);
    try {
      const res = await testGooglePlaces();
      setResult(res);
      toast(res.detail, res.ok ? "success" : "error");
    } catch {
      toast("Não conseguimos testar a conexão agora.", "error");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-surface-hover">
            <MapPin className="size-4.5 text-muted-foreground" />
          </span>
          <Badge variant={result?.ok ? "good" : hasKey ? "warning" : "neutral"}>
            {result?.ok ? "Conectada" : hasKey ? "Chave definida" : "Desconectada"}
          </Badge>
        </div>

        <h3 className="mt-3 text-sm font-semibold">Google Places</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Busca empresas reais do Google Maps na prospecção. Sem ela, a busca usa o
          diretório de demonstração.
        </p>

        {hasKey ? (
          <>
            <Button size="sm" variant="secondary" className="mt-3" disabled={testing} onClick={run}>
              {testing ? <Loader2 className="animate-spin" /> : <Plug />} Testar conexão
            </Button>
            {result && (
              <div
                className={`mt-3 rounded-lg px-3 py-2 text-[12px] ${
                  result.ok ? "bg-primary-soft text-primary-soft-fg" : "bg-danger-soft text-danger"
                }`}
              >
                <p>{result.detail}</p>
                {result.samples && result.samples.length > 0 && (
                  <p className="mt-1 opacity-80">Exemplos: {result.samples.join(" · ")}</p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="mt-3 space-y-1.5 border-t border-border pt-2.5 text-[11px] text-faint-foreground">
            <p className="font-medium text-muted-foreground">Para conectar:</p>
            <p>
              1. No Google Cloud, crie um projeto, ative a <strong>Places API (New)</strong> e
              vincule uma conta de faturamento.
            </p>
            <p>2. Gere uma chave de API em Credenciais.</p>
            <p>
              3. Defina <code>GOOGLE_PLACES_API_KEY</code> no <code>.env.local</code> (local) e nas
              variáveis de ambiente da Vercel (produção), e reinicie a aplicação.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
