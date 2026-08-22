"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Loader2, Mic, RefreshCw, Save, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { generateOutreach, saveGeneration } from "@/actions/ai";
import { FORMAT_LABEL } from "@/ai/prompts/generate-outreach";
import { formatDateTime } from "@/lib/format";
import type { AIGeneration, MessageFormat, MessageTone } from "@/types";
import { cn } from "@/lib/utils";

const FORMATS: MessageFormat[] = [
  "curta",
  "consultiva",
  "whatsapp",
  "instagram_dm",
  "email",
  "audio",
  "follow_up",
];

const TONES: Array<{ key: MessageTone; label: string }> = [
  { key: "mais_curto", label: "Mais curto" },
  { key: "mais_direto", label: "Mais direto" },
  { key: "mais_informal", label: "Mais informal" },
  { key: "mais_profissional", label: "Mais profissional" },
];

export function MessageGenerator({
  leadId,
  hasAnalysis,
  savedGenerations,
}: {
  leadId: string;
  hasAnalysis: boolean;
  savedGenerations: AIGeneration[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [format, setFormat] = React.useState<MessageFormat>("whatsapp");
  const [tone, setTone] = React.useState<MessageTone>("padrao");
  const [current, setCurrent] = React.useState<AIGeneration | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Identifica a geração mais recente: trocar de formato rápido fazia a
  // resposta lenta da requisição anterior sobrescrever a atual.
  const requestId = React.useRef(0);
  const variantRef = React.useRef(0);

  async function generate(nextFormat?: MessageFormat, nextTone?: MessageTone, bumpVariant = false) {
    const f = nextFormat ?? format;
    const t = nextTone ?? tone;
    // O ref não sofre com o closure obsoleto de dois cliques seguidos, que
    // pediam a mesma variante duas vezes.
    const v = bumpVariant ? variantRef.current + 1 : variantRef.current;
    if (bumpVariant) variantRef.current = v;
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await generateOutreach(leadId, f, t, v);
      if (id !== requestId.current) return;
      if ("error" in res) {
        toast(res.error, "error");
        return;
      }
      setCurrent(res.generation);
    } catch {
      if (id === requestId.current) {
        toast("Não conseguimos gerar a mensagem agora. Tente novamente.", "error");
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  async function copy() {
    if (!current?.content) return;
    await navigator.clipboard.writeText(current.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast("Mensagem copiada.");
  }

  async function save() {
    if (!current) return;
    try {
      await saveGeneration(current.id);
      setCurrent({ ...current, saved: true });
      toast("Mensagem salva no histórico do lead.");
      // Sem o refresh a lista "Mensagens salvas" (renderizada no servidor)
      // só incluía a mensagem depois de um reload manual.
      router.refresh();
    } catch {
      toast("Não conseguimos salvar a mensagem. Tente novamente.", "error");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Gerar abordagem com IA
          </CardTitle>
          <CardDescription>
            A mensagem usa o problema real identificado na análise — nunca um texto genérico.
            A primeira abordagem cria curiosidade sem revelar toda a solução.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={format === f}
                disabled={loading}
                onClick={() => {
                  setFormat(f);
                  setTone("padrao");
                  generate(f, "padrao");
                }}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  format === f
                    ? "border-primary bg-primary-soft text-primary-soft-fg"
                    : "border-border bg-surface text-muted-foreground hover:border-border-strong"
                )}
              >
                {f === "audio" && <Mic className="size-3.5" />}
                {FORMAT_LABEL[f]}
              </button>
            ))}
          </div>

          {!hasAnalysis && (
            <p className="rounded-lg bg-warning-soft px-4 py-3 text-[13px] text-warning">
              Este lead ainda não foi analisado. Clique em “Analisar oportunidade” no topo da página
              — o gerador precisa do problema identificado para personalizar a mensagem.
            </p>
          )}

          {(current || loading) && (
            <div className="rounded-xl border border-border bg-surface-hover/40 p-4">
              {loading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Escrevendo mensagem personalizada…
                </div>
              ) : (
                current && (
                  <>
                    <div className="mb-2 flex items-center justify-between">
                      <Badge variant="neutral">
                        {FORMAT_LABEL[current.format ?? "whatsapp"]}
                        {current.tone && current.tone !== "padrao"
                          ? ` · ${TONES.find((t) => t.key === current.tone)?.label}`
                          : ""}
                      </Badge>
                      <span className="text-[11px] text-faint-foreground">{current.model}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{current.content}</p>
                  </>
                )
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => generate(undefined, undefined, true)} disabled={loading || !hasAnalysis}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {current ? "Gerar novamente" : "Gerar mensagem"}
            </Button>
            {TONES.map((t) => (
              <Button
                key={t.key}
                variant={tone === t.key ? "soft" : "secondary"}
                size="sm"
                disabled={loading || !hasAnalysis}
                onClick={() => {
                  setTone(t.key);
                  generate(undefined, t.key);
                }}
              >
                {t.label}
              </Button>
            ))}
            {current && !loading && (
              <>
                <Button variant="secondary" size="sm" onClick={copy}>
                  {copied ? <Check className="text-primary" /> : <Copy />} Copiar
                </Button>
                <Button variant="secondary" size="sm" onClick={save} disabled={current.saved}>
                  <Save /> {current.saved ? "Salva" : "Salvar"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {savedGenerations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Mensagens salvas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {savedGenerations.map((g) => (
              <div key={g.id} className="rounded-lg border border-border p-3.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <Badge variant="neutral">{FORMAT_LABEL[g.format ?? "whatsapp"]}</Badge>
                  <span className="text-[11px] text-faint-foreground">{formatDateTime(g.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                  {g.content}
                </p>
                <Button
                  variant="ghost"
                  size="xs"
                  className="mt-2"
                  onClick={async () => {
                    await navigator.clipboard.writeText(g.content);
                    toast("Mensagem copiada.");
                  }}
                >
                  <Copy /> Copiar
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
