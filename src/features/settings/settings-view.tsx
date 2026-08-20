"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import {
  updateCompanyProfile,
  updateOrganization,
  updateSettings,
  updateUserProfile,
} from "@/actions/management";
import { NICHES } from "@/providers/directory-data";
import type { CompanyProfile, Database, Organization, User } from "@/types";

const OUTREACH_RULES = [
  "Não revelar toda a solução na primeira mensagem",
  "Nunca usar frases vagas (\"vi uma oportunidade…\")",
  "Sempre mencionar o problema específico identificado",
  "Não inventar informações sobre a empresa",
  "Não prometer resultados",
  "Não enviar textos longos",
  "Criar curiosidade pela solução não revelada",
  "Manter linguagem humana, sem cara de IA",
];

export function SettingsView({
  user,
  organization,
  profile,
  settings,
}: {
  user: User;
  organization: Organization;
  profile: CompanyProfile;
  settings: Database["settings"];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState<string | null>(null);

  /* Perfil */
  const [name, setName] = React.useState(user.name);
  const [email, setEmail] = React.useState(user.email);

  /* Empresa */
  const [orgName, setOrgName] = React.useState(organization.name);
  const [currency, setCurrency] = React.useState(organization.currency);
  const [timezone, setTimezone] = React.useState(organization.timezone);
  const [country, setCountry] = React.useState(organization.country);

  /* Prospecção */
  const [minScore, setMinScore] = React.useState(String(settings.min_score));
  const [defaultNiche, setDefaultNiche] = React.useState(settings.default_niche);
  const [defaultCountry, setDefaultCountry] = React.useState(settings.default_country);

  /* IA — Sobre minha empresa */
  const [p, setP] = React.useState({
    company_name: profile.company_name,
    what_we_sell: profile.what_we_sell,
    target_customers: profile.target_customers,
    main_services: profile.main_services.join("\n"),
    average_ticket: profile.average_ticket,
    differentiators: profile.differentiators.join("\n"),
    problems_we_solve: profile.problems_we_solve.join("\n"),
    priority_niches: profile.priority_niches.join(", "),
    communication_style: profile.communication_style,
    never_say: profile.never_say.join("\n"),
  });

  async function run(key: string, fn: () => Promise<unknown>) {
    setSaving(key);
    try {
      await fn();
      toast("Configurações salvas.");
      router.refresh();
    } finally {
      setSaving(null);
    }
  }

  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  return (
    <Tabs defaultValue="perfil">
      <TabsList>
        <TabsTrigger value="perfil">Perfil</TabsTrigger>
        <TabsTrigger value="empresa">Empresa</TabsTrigger>
        <TabsTrigger value="prospeccao">Prospecção</TabsTrigger>
        <TabsTrigger value="ia">IA</TabsTrigger>
      </TabsList>

      <TabsContent value="perfil">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Seu perfil</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>E-mail</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button
              size="sm"
              onClick={() => run("perfil", () => updateUserProfile({ name, email }))}
              disabled={saving === "perfil"}
            >
              {saving === "perfil" ? <Loader2 className="animate-spin" /> : <Save />} Salvar
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="empresa">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Organização</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Nome da empresa</Label>
              <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Moeda</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["BRL", "EUR", "USD"].map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["America/Sao_Paulo", "Europe/Lisbon", "America/Fortaleza", "Europe/Madrid"].map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>País</Label>
                <Input value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
            </div>
            <Button
              size="sm"
              onClick={() =>
                run("empresa", () => updateOrganization({ name: orgName, currency, timezone, country }))
              }
              disabled={saving === "empresa"}
            >
              {saving === "empresa" ? <Loader2 className="animate-spin" /> : <Save />} Salvar
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="prospeccao">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Regras de prospecção</CardTitle>
            <CardDescription>Padrões usados nas buscas e na qualificação automática.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Score mínimo para qualificar</Label>
              <Input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Leads com score igual ou acima entram como “qualificados” nas métricas.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Nicho padrão</Label>
              <Select value={defaultNiche} onValueChange={setDefaultNiche}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {NICHES.map((n) => (
                    <SelectItem key={n.key} value={n.key}>{n.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>País padrão</Label>
              <Input value={defaultCountry} onChange={(e) => setDefaultCountry(e.target.value)} />
            </div>
            <Button
              size="sm"
              onClick={() =>
                run("prospeccao", () =>
                  updateSettings({
                    min_score: parseInt(minScore, 10) || 60,
                    default_niche: defaultNiche,
                    default_country: defaultCountry,
                  })
                )
              }
              disabled={saving === "prospeccao"}
            >
              {saving === "prospeccao" ? <Loader2 className="animate-spin" /> : <Save />} Salvar
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="ia">
        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <Card>
            <CardHeader>
              <CardTitle>Sobre minha empresa</CardTitle>
              <CardDescription>
                Este é o contexto que a IA usa em TODAS as análises e mensagens. Quanto mais preciso,
                mais personalizadas as abordagens.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Nome" value={p.company_name} onChange={(v) => setP({ ...p, company_name: v })} />
              <FieldArea label="O que vendemos" value={p.what_we_sell} onChange={(v) => setP({ ...p, what_we_sell: v })} />
              <FieldArea label="Para quem vendemos" value={p.target_customers} onChange={(v) => setP({ ...p, target_customers: v })} />
              <FieldArea label="Principais serviços (um por linha)" value={p.main_services} onChange={(v) => setP({ ...p, main_services: v })} />
              <Field label="Ticket médio" value={p.average_ticket} onChange={(v) => setP({ ...p, average_ticket: v })} />
              <FieldArea label="Diferenciais (um por linha)" value={p.differentiators} onChange={(v) => setP({ ...p, differentiators: v })} />
              <FieldArea label="Problemas que resolvemos (um por linha)" value={p.problems_we_solve} onChange={(v) => setP({ ...p, problems_we_solve: v })} />
              <Field label="Nichos prioritários (separados por vírgula)" value={p.priority_niches} onChange={(v) => setP({ ...p, priority_niches: v })} />
              <FieldArea label="Estilo de comunicação" value={p.communication_style} onChange={(v) => setP({ ...p, communication_style: v })} />
              <FieldArea label="Coisas que NUNCA devem ser ditas (uma por linha)" value={p.never_say} onChange={(v) => setP({ ...p, never_say: v })} />
              <Button
                size="sm"
                onClick={() =>
                  run("ia", () =>
                    updateCompanyProfile({
                      company_name: p.company_name,
                      what_we_sell: p.what_we_sell,
                      target_customers: p.target_customers,
                      main_services: lines(p.main_services),
                      average_ticket: p.average_ticket,
                      differentiators: lines(p.differentiators),
                      problems_we_solve: lines(p.problems_we_solve),
                      priority_niches: p.priority_niches.split(",").map((x) => x.trim()).filter(Boolean),
                      communication_style: p.communication_style,
                      never_say: lines(p.never_say),
                    })
                  )
                }
                disabled={saving === "ia"}
              >
                {saving === "ia" ? <Loader2 className="animate-spin" /> : <Save />} Salvar contexto da IA
              </Button>
            </CardContent>
          </Card>

          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Regras de abordagem</CardTitle>
              <CardDescription>Aplicadas automaticamente a toda geração de mensagem.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {OUTREACH_RULES.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-muted-foreground">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" /> {r}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function FieldArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} className="min-h-16" />
    </div>
  );
}
