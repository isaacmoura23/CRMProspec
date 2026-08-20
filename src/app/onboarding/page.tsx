"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Compass, Loader2, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { completeOnboarding } from "@/actions/management";
import { NICHES } from "@/providers/directory-data";
import { cn } from "@/lib/utils";

const STEPS = [
  "Sua empresa",
  "O que você vende",
  "Seus clientes",
  "Nichos",
  "Localização",
  "Comunicação",
  "Primeiros leads",
];

const STYLES = [
  { key: "consultivo", label: "Consultivo", description: "Especialista que percebeu algo específico e quer ajudar." },
  { key: "direto", label: "Direto", description: "Vai ao ponto com clareza, sem rodeios." },
  { key: "informal", label: "Informal", description: "Leve e próximo, como uma conversa entre conhecidos." },
  { key: "formal", label: "Profissional", description: "Polido e corporativo, sem perder a naturalidade." },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = React.useState(0);
  const [saving, setSaving] = React.useState(false);

  const [companyName, setCompanyName] = React.useState("");
  const [whatWeSell, setWhatWeSell] = React.useState("");
  const [targetCustomers, setTargetCustomers] = React.useState("");
  const [niches, setNiches] = React.useState<Set<string>>(new Set());
  const [country, setCountry] = React.useState("Brasil");
  const [style, setStyle] = React.useState("consultivo");

  const canNext = () => {
    if (step === 0) return companyName.trim().length >= 2;
    return true;
  };

  async function finish(goProspect: boolean) {
    setSaving(true);
    try {
      await completeOnboarding({
        company_name: companyName.trim(),
        what_we_sell: whatWeSell.trim(),
        target_customers: targetCustomers.trim(),
        priority_niches: [...niches],
        default_country: country,
        communication_style:
          STYLES.find((s) => s.key === style)?.description ?? "Consultivo e humano.",
      });
      router.push(goProspect ? "/prospectar" : "/dashboard");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary">
            <Target className="size-4.5 text-white" strokeWidth={2.5} />
          </span>
          <span className="font-semibold">
            Prospec<span className="text-primary">Atlas</span>
          </span>
        </div>

        {/* progresso */}
        <div className="mb-6 flex gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                i <= step ? "bg-primary" : "bg-border"
              )}
            />
          ))}
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 shadow-card">
          <p className="text-xs font-medium uppercase tracking-wide text-faint-foreground">
            Etapa {step + 1} de {STEPS.length}
          </p>

          {step === 0 && (
            <StepBlock title="Como sua empresa se chama?">
              <Input
                autoFocus
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Ex.: Atlas Digital"
              />
            </StepBlock>
          )}

          {step === 1 && (
            <StepBlock
              title="O que você vende?"
              hint="A IA usa isso para conectar o problema do prospect à sua solução."
            >
              <Textarea
                autoFocus
                value={whatWeSell}
                onChange={(e) => setWhatWeSell(e.target.value)}
                placeholder="Ex.: Sites profissionais, landing pages e sistemas web para pequenos negócios."
              />
            </StepBlock>
          )}

          {step === 2 && (
            <StepBlock title="Quem são seus clientes?">
              <Textarea
                autoFocus
                value={targetCustomers}
                onChange={(e) => setTargetCustomers(e.target.value)}
                placeholder="Ex.: Negócios locais com Instagram ativo mas sem estrutura digital própria."
              />
            </StepBlock>
          )}

          {step === 3 && (
            <StepBlock title="Quais nichos deseja prospectar?" hint="Escolha quantos quiser.">
              <div className="grid grid-cols-2 gap-2">
                {NICHES.map((n) => (
                  <button
                    key={n.key}
                    onClick={() =>
                      setNiches((prev) => {
                        const next = new Set(prev);
                        if (next.has(n.label)) next.delete(n.label);
                        else next.add(n.label);
                        return next;
                      })
                    }
                    className={cn(
                      "rounded-lg border px-3 py-2 text-[13px] text-left transition-colors cursor-pointer",
                      niches.has(n.label)
                        ? "border-primary bg-primary-soft text-primary-soft-fg font-medium"
                        : "border-border text-muted-foreground hover:border-border-strong"
                    )}
                  >
                    {n.label}
                  </button>
                ))}
              </div>
            </StepBlock>
          )}

          {step === 4 && (
            <StepBlock title="Onde deseja prospectar?">
              <div className="grid grid-cols-2 gap-2">
                {["Brasil", "Portugal", "Angola", "Moçambique"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCountry(c)}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-[13px] transition-colors cursor-pointer",
                      country === c
                        ? "border-primary bg-primary-soft text-primary-soft-fg font-medium"
                        : "border-border text-muted-foreground hover:border-border-strong"
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </StepBlock>
          )}

          {step === 5 && (
            <StepBlock title="Qual estilo de comunicação combina com você?">
              <div className="space-y-2">
                {STYLES.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStyle(s.key)}
                    className={cn(
                      "block w-full rounded-lg border px-3.5 py-2.5 text-left transition-colors cursor-pointer",
                      style === s.key
                        ? "border-primary bg-primary-soft/50"
                        : "border-border hover:border-border-strong"
                    )}
                  >
                    <span className="block text-[13px] font-medium">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{s.description}</span>
                  </button>
                ))}
              </div>
            </StepBlock>
          )}

          {step === 6 && (
            <StepBlock
              title="Tudo pronto. Vamos encontrar seus primeiros leads?"
              hint="Você pode ajustar tudo depois em Configurações."
            >
              <div className="flex flex-col gap-2">
                <Button size="lg" onClick={() => finish(true)} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Compass />}
                  Encontrar primeiros leads
                </Button>
                <Button variant="ghost" onClick={() => finish(false)} disabled={saving}>
                  Ir para o dashboard
                </Button>
              </div>
            </StepBlock>
          )}

          {step < 6 && (
            <div className="mt-6 flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
                <ArrowLeft /> Voltar
              </Button>
              <Button size="sm" onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>
                Continuar <ArrowRight />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {hint && <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}
