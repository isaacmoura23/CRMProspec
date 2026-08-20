"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckSquare,
  Compass,
  CornerDownLeft,
  LayoutDashboard,
  Plus,
  Search,
  Target,
  Workflow,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScoreBadge } from "@/components/score-badge";
import { globalSearch, type SearchResult } from "@/actions/search";
import { cn } from "@/lib/utils";

const QUICK_ACTIONS = [
  { label: "Prospectar novas empresas", href: "/prospectar", icon: Compass },
  { label: "Novo lead", href: "/leads?novo=1", icon: Plus },
  { label: "Ir para o Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Ir para Leads", href: "/leads", icon: Target },
  { label: "Ir para o Pipeline", href: "/pipeline", icon: Workflow },
  { label: "Criar tarefa", href: "/tarefas?nova=1", icon: CheckSquare },
  { label: "Abrir notificações", href: "/dashboard?notificacoes=1", icon: Bell },
];

export const OPEN_PALETTE_EVENT = "crm:open-palette";

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [active, setActive] = React.useState(0);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setActive(0);
    }
  }, [open]);

  React.useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await globalSearch(query));
        setActive(0);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const filteredActions = query.trim()
    ? QUICK_ACTIONS.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : QUICK_ACTIONS;

  const items: Array<{ label: string; href: string }> = [
    ...results.map((r) => ({ label: r.company, href: `/leads/${r.id}` })),
    ...filteredActions.map((a) => ({ label: a.label, href: a.href })),
  ];

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      go(items[active].href);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] max-w-xl translate-y-0 p-0 [&>button]:hidden">
        <DialogTitle className="sr-only">Busca global</DialogTitle>
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-faint-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Buscar leads, telefones, cidades ou ações…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-faint-foreground"
          />
          <kbd className="rounded border border-border bg-surface-hover px-1.5 py-0.5 text-[10px] text-faint-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {query.trim().length >= 2 && (
            <div className="mb-1">
              <p className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-faint-foreground">
                Leads
              </p>
              {searching && results.length === 0 && (
                <p className="px-2.5 py-2 text-[13px] text-muted-foreground">Buscando…</p>
              )}
              {!searching && results.length === 0 && (
                <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
                  Nenhum lead encontrado para “{query}”.
                </p>
              )}
              {results.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => go(`/leads/${r.id}`)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm cursor-pointer",
                    active === i && "bg-surface-hover"
                  )}
                >
                  <ScoreBadge score={r.score} size="sm" />
                  <span className="flex-1 truncate">
                    <span className="font-medium">{r.company}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.segment} · {r.city}
                      {r.match && ` · ${r.match}`}
                    </span>
                  </span>
                  {active === i && <CornerDownLeft className="size-3.5 text-faint-foreground" />}
                </button>
              ))}
            </div>
          )}
          <p className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-faint-foreground">
            Ações
          </p>
          {filteredActions.map((a, i) => {
            const idx = results.length + i;
            return (
              <button
                key={a.href}
                onClick={() => go(a.href)}
                onMouseEnter={() => setActive(idx)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm cursor-pointer",
                  active === idx && "bg-surface-hover"
                )}
              >
                <a.icon className="size-4 text-muted-foreground" />
                <span className="flex-1">{a.label}</span>
                {active === idx && <CornerDownLeft className="size-3.5 text-faint-foreground" />}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
