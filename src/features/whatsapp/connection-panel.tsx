"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Loader2, LogOut, PlugZap, Power, QrCode, Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/ui/toast";
import { connectWhatsapp, disconnectWhatsapp, logoutWhatsapp, refreshWhatsappPanel } from "@/actions/whatsapp";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { SessionStatus } from "@/lib/gateway-events";
import type { WhatsappActionResult, WhatsappPanelState } from "@/types/whatsapp";

const STATUS_LABEL: Record<SessionStatus, string> = {
  DISCONNECTED: "Desconectado",
  QR: "Aguardando leitura do QR Code",
  CONNECTING: "Conectando…",
  CONNECTED: "Conectado",
  NEEDS_RECONNECT: "Precisa reconectar",
};

const STATUS_BADGE: Record<SessionStatus, "neutral" | "warning" | "info" | "good" | "danger"> = {
  DISCONNECTED: "neutral",
  QR: "warning",
  CONNECTING: "info",
  CONNECTED: "good",
  NEEDS_RECONNECT: "danger",
};

/** Atualiza mais depressa enquanto algo está acontecendo (QR, conectando). */
const POLL_BUSY_MS = 2_500;
const POLL_IDLE_MS = 8_000;

export function ConnectionPanel({ initial, canConnect }: { initial: WhatsappPanelState; canConnect: boolean }) {
  const { toast } = useToast();
  const [state, setState] = React.useState(initial);
  const [pending, startTransition] = React.useTransition();

  const status = state.status?.status ?? null;
  const busy = status === "QR" || status === "CONNECTING";

  React.useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await refreshWhatsappPanel();
        if (!cancelled) setState(next);
      } catch {
        /* uma consulta que falha não derruba a tela: a próxima tenta de novo */
      }
    }, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busy]);

  function act(action: () => Promise<WhatsappActionResult>) {
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          setState(res.state);
          if (res.message) toast(res.message);
        } else toast(res.error, "error");
      } catch {
        toast("Não conseguimos concluir a ação. Tente novamente.", "error");
      }
    });
  }

  if (!state.configured) {
    return (
      <EmptyState
        icon={PlugZap}
        title="O gateway do WhatsApp ainda não está configurado"
        description="Gere as chaves com `node scripts/set-whatsapp-gateway.mjs` (elas não aparecem na tela), reinicie o servidor e inicie o gateway com `npm run gateway`. O passo a passo está em docs/WHATSAPP_LOCAL.md."
      />
    );
  }

  return (
    <div className="space-y-4">
      {state.status?.sendMode === "simulado" && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-info" />
          <p>
            <strong className="font-medium">Envio simulado.</strong> O gateway conecta de verdade e consulta números, mas <strong>nenhuma mensagem sai</strong> pelo
            WhatsApp: as mensagens aprovadas esperam na fila. Para testar com o seu próprio número, defina <code>WHATSAPP_ALLOWED_RECIPIENTS</code> no gateway.
          </p>
        </div>
      )}
      {state.status?.sendMode === "restrito" && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <strong className="font-medium">Teste restrito.</strong> Só {state.status.allowedCount === 1 ? "1 número da lista de teste recebe" : `${state.status.allowedCount} números da lista de teste recebem`}{" "}
            mensagens de verdade; para todos os outros o envio é simulado.
          </p>
        </div>
      )}
      {state.status?.sendMode === "real" && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <p>
            <strong className="font-medium">Envio real ligado.</strong> Mensagens aprovadas e autorizadas pela política saem de verdade para os leads, por um número que a Meta pode
            restringir. Para voltar ao modo seguro, defina <code>WHATSAPP_GATEWAY_DRY_RUN=1</code> no gateway.
          </p>
        </div>
      )}

      {!state.reachable && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[13px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="font-medium">Gateway offline</p>
            <p className="text-muted-foreground">{state.error}</p>
            {state.link && (
              <p className="text-muted-foreground">
                Último estado que o CRM recebeu: {STATUS_LABEL[state.link.status]} ({timeAgo(state.link.lastEventAt)}).
              </p>
            )}
          </div>
        </div>
      )}

      {state.reachable && state.status && (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="size-4" /> Número de prospecção
                <Badge variant={STATUS_BADGE[state.status.status]}>
                  {state.status.status === "CONNECTING" && <Loader2 className="size-3 animate-spin" />}
                  {STATUS_LABEL[state.status.status]}
                </Badge>
              </CardTitle>
              <CardDescription>
                {state.status.status === "CONNECTED"
                  ? `${state.status.pushName ?? "WhatsApp"} · ${state.status.phone ?? "número desconhecido"}`
                  : "Use um número dedicado à prospecção, separado do seu WhatsApp pessoal e de qualquer outro sistema."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {status === "QR" && (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-white p-4 sm:flex-row sm:items-start">
                {state.status.qrDataUrl ? (
                  // Imagem gerada pelo gateway (data URL); não passa pelo otimizador do Next.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={state.status.qrDataUrl} alt="QR Code para vincular o WhatsApp" width={256} height={256} className="size-64 shrink-0" />
                ) : (
                  <div className="flex size-64 shrink-0 items-center justify-center text-[13px] text-muted-foreground">
                    {canConnect ? <Loader2 className="size-5 animate-spin" /> : "Apenas owner e admin veem o QR Code."}
                  </div>
                )}
                <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-foreground">
                  <li>No celular, abra o WhatsApp do número de prospecção.</li>
                  <li>
                    Toque em <strong>Aparelhos conectados</strong> e depois em <strong>Conectar um aparelho</strong>.
                  </li>
                  <li>Aponte a câmera para este código.</li>
                  <li className="text-muted-foreground">O código se renova sozinho; se expirar sem leitura, gere outro.</li>
                </ol>
              </div>
            )}

            {status === "NEEDS_RECONNECT" && (
              <p className="text-[13px] text-danger">
                A sessão foi encerrada (pelo celular ou por queda do vínculo). Leia o QR Code de novo para voltar.
                {state.status.lastError ? ` Motivo informado: ${state.status.lastError}` : ""}
              </p>
            )}
            {status === "DISCONNECTED" && state.status.lastError && <p className="text-[13px] text-muted-foreground">{state.status.lastError}</p>}

            {canConnect ? (
              <div className="flex flex-wrap gap-2">
                {(status === "DISCONNECTED" || status === "NEEDS_RECONNECT") && (
                  <Button disabled={pending} onClick={() => act(connectWhatsapp)}>
                    {pending ? <Loader2 className="animate-spin" /> : <QrCode />} Gerar QR Code
                  </Button>
                )}
                {(status === "QR" || status === "CONNECTING") && (
                  <Button variant="secondary" disabled={pending} onClick={() => act(disconnectWhatsapp)}>
                    <Power /> Cancelar
                  </Button>
                )}
                {status === "CONNECTED" && (
                  <>
                    <Button variant="secondary" disabled={pending} onClick={() => act(disconnectWhatsapp)}>
                      <Power /> Desconectar
                    </Button>
                    <Button
                      variant="danger-ghost"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm("Sair deste dispositivo apaga a sessão: para voltar será preciso ler o QR Code de novo. Continuar?")) act(logoutWhatsapp);
                      }}
                    >
                      <LogOut /> Sair deste dispositivo
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Só owner e admin conectam ou desconectam o WhatsApp.</p>
            )}
            {status === "CONNECTED" && <p className="text-xs text-muted-foreground">“Desconectar” guarda a sessão (reconectar não pede novo QR). “Sair” a apaga.</p>}
          </CardContent>
        </Card>
      )}

      {/* Diagnóstico da ponte gateway → CRM: é onde os problemas silenciosos aparecem. */}
      {state.reachable && (
        <Card>
          <CardHeader>
            <CardTitle>Entrega de eventos ao CRM</CardTitle>
            <CardDescription>O gateway avisa o CRM de cada mudança de estado por webhook assinado, e reenvia até o CRM confirmar.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-[13px]">
            {!state.webhookConfigured && (
              <p className="flex items-center gap-1.5 text-warning">
                <AlertTriangle className="size-4" /> O CRM não tem WHATSAPP_WEBHOOK_SECRET: recusa todos os eventos do gateway.
              </p>
            )}
            {state.link ? (
              <p className="flex items-center gap-1.5">
                <CheckCircle2 className="size-4 text-primary" />
                Último evento recebido: {STATUS_LABEL[state.link.status].toLowerCase()} · {formatDateTime(state.link.lastEventAt)}
              </p>
            ) : (
              <p className="text-muted-foreground">O CRM ainda não recebeu nenhum evento do gateway.</p>
            )}
            {state.status && state.link && state.status.status !== state.link.status && (
              <p className="text-warning">
                O gateway diz “{STATUS_LABEL[state.status.status].toLowerCase()}”, mas o CRM ainda registra “{STATUS_LABEL[state.link.status].toLowerCase()}”. Se
                persistir, confira WHATSAPP_WEBHOOK_SECRET e CRM_WEBHOOK_URL.
              </p>
            )}
            {state.outbox && state.outbox.pending > 0 && (
              <p className="text-warning">
                {state.outbox.pending === 1 ? "1 evento aguarda" : `${state.outbox.pending} eventos aguardam`} entrega ao CRM (o gateway tenta de novo sozinho).
              </p>
            )}
            {state.outbox && state.outbox.dead > 0 && (
              <p className="text-danger">
                {state.outbox.dead === 1 ? "1 evento foi recusado" : `${state.outbox.dead} eventos foram recusados`} pelo CRM e ficou guardado no gateway por 7 dias.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
