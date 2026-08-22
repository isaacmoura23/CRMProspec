"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { createWebhook, deleteWebhook } from "@/actions/management";
import type { Webhook } from "@/types";

const EVENTS = [
  "lead.created",
  "lead.updated",
  "lead.qualified",
  "message.received",
  "deal.created",
  "deal.won",
  "deal.lost",
  "task.created",
];

export function WebhooksManager({ webhooks }: { webhooks: Webhook[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<Set<string>>(new Set(["lead.created"]));
  const [saving, setSaving] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <WebhookIcon className="size-4 text-muted-foreground" /> Webhooks
          </CardTitle>
          <CardDescription>Receba eventos do CRM em sistemas externos (n8n, Zapier, backend próprio).</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm">
              <Plus /> Novo webhook
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Novo webhook</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>URL de destino</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://seu-n8n.com/webhook/…" />
              </div>
              <div className="space-y-1.5">
                <Label>Eventos</Label>
                <div className="grid grid-cols-2 gap-2">
                  {EVENTS.map((ev) => (
                    <label key={ev} className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <Checkbox
                        checked={events.has(ev)}
                        onCheckedChange={(v) =>
                          setEvents((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(ev);
                            else next.delete(ev);
                            return next;
                          })
                        }
                      />
                      <code className="text-xs">{ev}</code>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button
                disabled={saving || !url.trim() || events.size === 0}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const res = await createWebhook(url, [...events]);
                    if (res.error) {
                      toast(res.error, "error");
                      return;
                    }
                    toast("Webhook criado.");
                    setOpen(false);
                    setUrl("");
                    setEvents(new Set(["lead.created"]));
                    router.refresh();
                  } catch {
                    toast("Não conseguimos criar o webhook. Tente novamente.", "error");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Criar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {webhooks.length === 0 ? (
          <p className="py-2 text-[13px] text-muted-foreground">Nenhum webhook configurado.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((w) => (
              <div key={w.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                <code className="min-w-0 flex-1 truncate text-xs">{w.url}</code>
                <span className="flex flex-wrap gap-1">
                  {w.events.slice(0, 3).map((e) => (
                    <Badge key={e} variant="neutral" className="text-[10px]">
                      {e}
                    </Badge>
                  ))}
                  {w.events.length > 3 && (
                    <Badge variant="neutral" className="text-[10px]">
                      +{w.events.length - 3}
                    </Badge>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Excluir o webhook ${w.url}`}
                  onClick={async () => {
                    if (!confirm("Excluir este webhook?")) return;
                    try {
                      await deleteWebhook(w.id);
                      toast("Webhook excluído.");
                      router.refresh();
                    } catch {
                      toast("Não conseguimos excluir o webhook. Tente novamente.", "error");
                    }
                  }}
                  className="rounded p-1 text-faint-foreground hover:bg-danger-soft hover:text-danger cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
