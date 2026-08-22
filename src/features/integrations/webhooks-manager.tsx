"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2, Pause, Play, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
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
import { createWebhook, deleteWebhook, testWebhook, toggleWebhook } from "@/actions/management";
import { EVENT_LABEL, EVENT_TYPES } from "@/services/event-catalog";
import { formatDateTime } from "@/lib/format";
import type { Webhook } from "@/types";

export function WebhooksManager({ webhooks }: { webhooks: Webhook[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<Set<string>>(new Set(["lead.created"]));
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState<string | null>(null);
  // O segredo só existe em claro neste retorno; depois disso não é reexibido.
  const [newSecret, setNewSecret] = React.useState<string | null>(null);

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
                <div className="grid gap-2 sm:grid-cols-2">
                  {EVENT_TYPES.map((ev) => (
                    <label key={ev} className="flex cursor-pointer items-start gap-2 text-[13px]">
                      <Checkbox
                        className="mt-0.5"
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
                      <span className="min-w-0">
                        <span className="block">{EVENT_LABEL[ev]}</span>
                        <code className="block truncate text-[11px] text-faint-foreground">{ev}</code>
                      </span>
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
                    if (res.secret) setNewSecret(res.secret);
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
      <CardContent className="space-y-3">
        {newSecret && (
          <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3">
            <p className="text-[13px] font-medium text-primary-soft-fg">
              Guarde o segredo de assinatura — ele não será exibido de novo.
            </p>
            <p className="mt-1 text-[11px] text-primary-soft-fg/80">
              Cada entrega vai assinada em <code>X-ProspecAtlas-Signature</code> como
              HMAC SHA-256 do corpo.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 text-xs">
                {newSecret}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(newSecret);
                  toast("Segredo copiado.");
                }}
              >
                <Copy /> Copiar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNewSecret(null)}>
                Ok
              </Button>
            </div>
          </div>
        )}

        {webhooks.length === 0 ? (
          <p className="py-2 text-[13px] text-muted-foreground">Nenhum webhook configurado.</p>
        ) : (
          <div className="space-y-2">
            {webhooks.map((w) => (
              <div key={w.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-3">
                  <code className="min-w-0 flex-1 truncate text-xs">{w.url}</code>
                  <Badge variant={w.active ? "good" : "neutral"}>
                    {w.active ? "Ativo" : "Pausado"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={testing === w.id}
                    onClick={async () => {
                      setTesting(w.id);
                      try {
                        const res = await testWebhook(w.id);
                        toast(res.detail, res.ok ? "success" : "error");
                        router.refresh();
                      } catch {
                        toast("Não conseguimos testar agora. Tente novamente.", "error");
                      } finally {
                        setTesting(null);
                      }
                    }}
                  >
                    {testing === w.id ? <Loader2 className="animate-spin" /> : <Send />} Testar
                  </Button>
                  <button
                    type="button"
                    aria-label={`${w.active ? "Pausar" : "Reativar"} o webhook ${w.url}`}
                    onClick={async () => {
                      try {
                        await toggleWebhook(w.id);
                        router.refresh();
                      } catch {
                        toast("Não conseguimos alterar o webhook.", "error");
                      }
                    }}
                    className="rounded p-1 text-faint-foreground hover:bg-surface-hover hover:text-foreground cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {w.active ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                  </button>
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

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {w.events.map((e) => (
                    <Badge key={e} variant="neutral" className="text-[10px]">
                      {e}
                    </Badge>
                  ))}
                </div>

                {w.last_delivery_at && (
                  <p className="mt-2 text-[11px] text-faint-foreground">
                    Última entrega {formatDateTime(w.last_delivery_at)} ·{" "}
                    {w.last_error ? (
                      <span className="text-danger">{w.last_error}</span>
                    ) : (
                      <span className="text-primary">HTTP {w.last_status}</span>
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
