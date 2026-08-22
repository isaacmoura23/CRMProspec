"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, Search } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OPEN_PALETTE_EVENT } from "@/components/layout/command-palette";
import { markAllNotificationsRead, markNotificationRead } from "@/actions/notifications";
import { logout } from "@/actions/auth";
import { timeAgo } from "@/lib/format";
import type { AppNotification, User } from "@/types";
import { cn } from "@/lib/utils";

export function Topbar({
  user,
  notifications,
}: {
  user: User;
  notifications: AppNotification[];
}) {
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-sm lg:px-8">
      <button
        type="button"
        aria-label="Abrir busca global"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
        className="flex h-8 w-full max-w-xs items-center gap-2.5 rounded-lg border border-border bg-surface px-3 text-[13px] text-faint-foreground shadow-sm transition-colors hover:border-border-strong cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Buscar…</span>
        <kbd className="rounded border border-border bg-surface-hover px-1.5 text-[10px]">
          Ctrl K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label={
                unread > 0 ? `Notificações (${unread} não lidas)` : "Notificações"
              }
            >
              <Bell className="size-4" />
              {unread > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-white"
                >
                  {unread}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center justify-between pr-2">
              <DropdownMenuLabel>Notificações</DropdownMenuLabel>
              {unread > 0 && (
                <button
                  onClick={() => markAllNotificationsRead()}
                  className="text-[11px] font-medium text-primary hover:underline cursor-pointer"
                >
                  Marcar todas como lidas
                </button>
              )}
            </div>
            <DropdownMenuSeparator />
            {notifications.length === 0 && (
              <p className="px-2.5 py-4 text-center text-[13px] text-muted-foreground">
                Nenhuma notificação por aqui.
              </p>
            )}
            {notifications.slice(0, 8).map((n) => (
              <DropdownMenuItem key={n.id} asChild>
                <Link
                  href={n.link ?? "#"}
                  onClick={() => !n.read && markNotificationRead(n.id)}
                  className="flex-col items-start gap-0.5"
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        n.read ? "bg-border-strong" : "bg-primary"
                      )}
                    />
                    <span className={cn("flex-1 text-[13px]", !n.read && "font-medium")}>
                      {n.title}
                    </span>
                    <span className="text-[11px] text-faint-foreground">
                      {timeAgo(n.created_at)}
                    </span>
                  </span>
                  {n.body && (
                    <span className="pl-3.5 text-xs text-muted-foreground">{n.body}</span>
                  )}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Abaixo de `sm` o nome fica oculto e sobra só o avatar, então o
                rótulo precisa vir do aria-label. */}
            <button
              type="button"
              aria-label={`Conta de ${user.name}`}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-hover cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Avatar name={user.name} size="sm" />
              <span className="hidden text-[13px] font-medium sm:block">{user.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>
              {user.name}
              <span className="block font-normal text-muted-foreground">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/configuracoes">Configurações</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/equipe">Equipe</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onClick={() => logout()}>
              Sair
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
