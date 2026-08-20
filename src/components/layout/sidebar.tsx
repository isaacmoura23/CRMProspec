"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bot,
  Building2,
  Calendar,
  CheckSquare,
  Compass,
  FileText,
  LayoutDashboard,
  MessageSquare,
  Plug,
  Repeat,
  Settings,
  Sparkles,
  Target,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SECTIONS: Array<{ title: string | null; items: NavItem[] }> = [
  {
    title: null,
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/prospectar", label: "Prospectar", icon: Compass },
      { href: "/leads", label: "Leads", icon: Target },
      { href: "/pipeline", label: "Pipeline", icon: Workflow },
      { href: "/conversas", label: "Conversas", icon: MessageSquare },
      { href: "/follow-ups", label: "Follow-ups", icon: Repeat },
      { href: "/tarefas", label: "Tarefas", icon: CheckSquare },
    ],
  },
  {
    title: "Inteligência",
    items: [
      { href: "/analises", label: "Análises IA", icon: Sparkles },
      { href: "/campanhas", label: "Campanhas", icon: Calendar },
      { href: "/automacoes", label: "Automações", icon: Bot },
    ],
  },
  {
    title: "Gestão",
    items: [
      { href: "/clientes", label: "Clientes", icon: Building2 },
      { href: "/propostas", label: "Propostas", icon: FileText },
      { href: "/relatorios", label: "Relatórios", icon: BarChart3 },
    ],
  },
  {
    title: "Sistema",
    items: [
      { href: "/integracoes", label: "Integrações", icon: Plug },
      { href: "/equipe", label: "Equipe", icon: UsersRound },
      { href: "/configuracoes", label: "Configurações", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col bg-sidebar lg:flex">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-5 pb-5 pt-6">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary">
          <Target className="size-4 text-white" strokeWidth={2.5} />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-white">
          Prospec<span className="text-primary">Atlas</span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        {SECTIONS.map((section, i) => (
          <div key={i} className={cn(i > 0 && "mt-6")}>
            {section.title && (
              <p className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wider text-sidebar-fg/60">
                {section.title}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                        active
                          ? "bg-sidebar-hover text-sidebar-fg-active"
                          : "text-sidebar-fg hover:bg-sidebar-hover/60 hover:text-sidebar-fg-active"
                      )}
                    >
                      <item.icon
                        className={cn("size-4", active ? "text-primary" : "text-sidebar-fg/70")}
                      />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/5 px-5 py-4">
        <p className="text-[11px] text-sidebar-fg/50">
          Encontre quem deveria ser<br />seu próximo cliente.
        </p>
      </div>
    </aside>
  );
}
