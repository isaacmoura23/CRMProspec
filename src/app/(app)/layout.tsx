import { getDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { CommandPalette } from "@/components/layout/command-palette";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const db = getDb();
  const user = await getCurrentUser();
  const notifications = [...db.notifications]
    .filter((n) => n.user_id === user.id || n.user_id === "usr_zack")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <ToastProvider>
      <TooltipProvider delayDuration={300}>
        <div className="min-h-screen">
          <Sidebar />
          <div className="lg:pl-60">
            <Topbar user={user} notifications={notifications} />
            <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">{children}</main>
          </div>
          <CommandPalette />
        </div>
      </TooltipProvider>
    </ToastProvider>
  );
}
