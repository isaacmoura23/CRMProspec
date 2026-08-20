"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { Campaign, User } from "@/types";

const ALL = "__all__";

export function LeadsFilters({
  segments,
  cities,
  users,
  campaigns,
}: {
  segments: string[];
  cities: string[];
  users: User[];
  campaigns: Campaign[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = React.useState(params.get("q") ?? "");

  const set = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (!value || value === ALL) next.delete(key);
      else next.set(key, value);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  // debounce da busca textual
  React.useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== q) set("q", q || null);
    }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasFilters = ["q", "status", "nicho", "cidade", "site", "temperatura", "origem", "campanha", "resp", "score_min"].some((k) => params.get(k));

  const selectCls = "h-8 w-auto min-w-28 text-[13px]";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar empresa, cidade, telefone…"
          className="h-8 w-60 pl-8 text-[13px]"
        />
      </div>

      <Select value={params.get("temperatura") ?? ALL} onValueChange={(v) => set("temperatura", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Score" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Score: todos</SelectItem>
          <SelectItem value="quente">🔥 Quente (80+)</SelectItem>
          <SelectItem value="bom">Bom (60–79)</SelectItem>
          <SelectItem value="medio">Médio (40–59)</SelectItem>
          <SelectItem value="frio">Frio (0–39)</SelectItem>
        </SelectContent>
      </Select>

      <Select value={params.get("nicho") ?? ALL} onValueChange={(v) => set("nicho", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Nicho" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Nicho: todos</SelectItem>
          {segments.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={params.get("cidade") ?? ALL} onValueChange={(v) => set("cidade", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Cidade" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Cidade: todas</SelectItem>
          {cities.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={params.get("site") ?? ALL} onValueChange={(v) => set("site", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Site" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Site: todos</SelectItem>
          <SelectItem value="sem">Sem site</SelectItem>
          <SelectItem value="com">Possui site</SelectItem>
          <SelectItem value="ruim">Site ruim/desatualizado</SelectItem>
        </SelectContent>
      </Select>

      <Select value={params.get("status") ?? ALL} onValueChange={(v) => set("status", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Status: todos</SelectItem>
          {[
            ["novo", "Novo"],
            ["analisado", "Analisado"],
            ["qualificado", "Qualificado"],
            ["pronto_contato", "Pronto para contato"],
            ["contatado", "Contatado"],
            ["respondeu", "Respondeu"],
            ["interessado", "Interessado"],
            ["reuniao", "Reunião"],
            ["proposta", "Proposta"],
            ["negociacao", "Negociação"],
            ["fechado", "Fechado"],
            ["perdido", "Perdido"],
          ].map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={params.get("resp") ?? ALL} onValueChange={(v) => set("resp", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Responsável" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Responsável: todos</SelectItem>
          <SelectItem value="__none__">Sem responsável</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={params.get("campanha") ?? ALL} onValueChange={(v) => set("campanha", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Campanha" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Campanha: todas</SelectItem>
          {campaigns.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={params.get("origem") ?? ALL} onValueChange={(v) => set("origem", v)}>
        <SelectTrigger className={selectCls}>
          <SelectValue placeholder="Origem" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Origem: todas</SelectItem>
          <SelectItem value="google_places">Google Places</SelectItem>
          <SelectItem value="diretorio">Diretório</SelectItem>
          <SelectItem value="csv">CSV</SelectItem>
          <SelectItem value="manual">Manual</SelectItem>
          <SelectItem value="demo">Demonstração</SelectItem>
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button variant="ghost" size="xs" onClick={() => router.replace(pathname)}>
          <X className="size-3.5" /> Limpar
        </Button>
      )}
    </div>
  );
}
