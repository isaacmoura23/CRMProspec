import Link from "next/link";
import { CalendarClock, ClipboardCheck, Clock, Gauge, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber, timeAgo } from "@/lib/format";
import type { MessageRow, QueueRow, SellerPanelData } from "@/services/outreach/panel";
import type { OutreachCycleStatus, OutreachMessageStatus } from "@/types/agents";

/** Só quem administra vê o número inteiro dos prospects; os demais, só o final. */
export function shownPhone(phone: string, canAdmin: boolean): string {
  if (canAdmin) return phone;
  return `••••${phone.replace(/\D/g, "").slice(-4)}`;
}

export function SellerStats({ data }: { data: SellerPanelData }) {
  const { stats, config } = data;
  const pct = stats.cap > 0 ? Math.min(100, Math.round((stats.sentToday / stats.cap) * 100)) : 100;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardContent className="space-y-1 p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Gauge className="size-3.5" /> Enviadas hoje
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatNumber(stats.sentToday)} <span className="text-base font-normal text-muted-foreground">/ {formatNumber(stats.cap)}</span>
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Uso do teto diário">
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {stats.warmingUp ? `Aquecimento do número: o teto sobe por semana até ${config.daily_cap_max}.` : `Teto diário configurado: ${config.daily_cap_max}.`}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Clock className="size-3.5" /> Janela de envio
          </p>
          <p className="text-2xl font-semibold">{stats.windowOpen ? "Aberta" : "Fechada"}</p>
          <p className="text-xs text-muted-foreground">
            {stats.windowOpen
              ? `Até ${config.end_hour}h. ${stats.nextAllowedAt ? `Próximo envio liberado às ${new Date(stats.nextAllowedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Sao_Paulo" })}.` : "Sem espera entre envios agora."}`
              : stats.nextWindowOpen
                ? `Abre ${formatDateTime(stats.nextWindowOpen)}.`
                : "Nenhum dia da semana habilitado."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Search className="size-3.5" /> Consultas de número hoje
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatNumber(stats.lookupsToday)} <span className="text-base font-normal text-muted-foreground">/ {formatNumber(config.lookups_per_day)}</span>
          </p>
          <p className="text-xs text-muted-foreground">Cada lead tem o número conferido no WhatsApp antes de a mensagem ser escrita.</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ClipboardCheck className="size-3.5" /> Aguardando sua aprovação
          </p>
          <p className="text-2xl font-semibold tabular-nums">{formatNumber(data.pendingApprovals)}</p>
          <p className="text-xs text-muted-foreground">
            {data.pendingApprovals > 0 ? (
              <Link href="/agentes/aprovacao" className="font-medium text-primary hover:underline">
                Ler e aprovar as mensagens
              </Link>
            ) : data.mode === "aprovacao" ? (
              "Nenhuma mensagem esperando."
            ) : (
              "O modo atual não pede aprovação."
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

const CYCLE_LABEL: Record<OutreachCycleStatus, string> = {
  agendado: "Agendada",
  reivindicado: "Enviando",
  enviado: "Enviada",
  pulado: "Não enviada",
  falhou: "Falhou",
  incerto: "Sem confirmação",
  cancelado: "Cancelada",
};
const CYCLE_BADGE: Record<OutreachCycleStatus, "neutral" | "info" | "good" | "outline" | "danger" | "warning"> = {
  agendado: "neutral",
  reivindicado: "info",
  enviado: "good",
  pulado: "outline",
  falhou: "danger",
  incerto: "warning",
  cancelado: "outline",
};

export function OutreachQueue({ rows, canAdmin }: { rows: QueueRow[]; canAdmin: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fila de envio</CardTitle>
        <CardDescription>
          Mensagens aprovadas (ou automáticas) esperando a política de envio. O que acabou de sair aparece em “Mensagens enviadas”.
        </CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nada na fila.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/leads/${r.lead_id}`} className="text-[13px] font-medium hover:underline">
                  {r.lead_name}
                </Link>
                <Badge variant="outline">{r.touch}º toque</Badge>
                <Badge variant={CYCLE_BADGE[r.status]}>{CYCLE_LABEL[r.status]}</Badge>
                <span className="text-xs text-muted-foreground">{shownPhone(r.phone, canAdmin)}</span>
                {r.status === "agendado" && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarClock className="size-3.5" /> {formatDateTime(r.not_before)}
                  </span>
                )}
              </div>
              {r.status === "incerto" && (
                <p className="text-xs text-warning">
                  O WhatsApp não confirmou se esta mensagem saiu. Ela <strong>não será reenviada</strong>: confira no WhatsApp antes de agir.
                </p>
              )}
              {r.note && r.status !== "incerto" && (
                <p className={`text-xs ${r.status === "falhou" ? "text-danger" : "text-muted-foreground"}`}>
                  {r.note}
                  {r.attempts > 0 ? ` (tentativa ${r.attempts})` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const MESSAGE_LABEL: Record<OutreachMessageStatus, string> = {
  QUEUED: "Na fila",
  SENT: "Enviada",
  DELIVERED: "Entregue",
  READ: "Lida",
  FAILED: "Falhou",
  UNCERTAIN: "Sem confirmação",
};
const MESSAGE_BADGE: Record<OutreachMessageStatus, "neutral" | "info" | "good" | "danger" | "warning"> = {
  QUEUED: "neutral",
  SENT: "info",
  DELIVERED: "good",
  READ: "good",
  FAILED: "danger",
  UNCERTAIN: "warning",
};

export function SentMessages({ rows, canAdmin }: { rows: MessageRow[]; canAdmin: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mensagens enviadas</CardTitle>
        <CardDescription>O estado é o que o WhatsApp confirmou: enviada, entregue ou lida. Só avança, nunca volta.</CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nenhuma mensagem enviada ainda.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((m) => (
            <li key={m.id} className="space-y-1.5 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/leads/${m.lead_id}`} className="text-[13px] font-medium hover:underline">
                  {m.lead_name}
                </Link>
                <Badge variant={MESSAGE_BADGE[m.status]}>{MESSAGE_LABEL[m.status]}</Badge>
                <span className="text-xs text-muted-foreground">{shownPhone(m.phone, canAdmin)}</span>
                <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(m.sent_at)}>
                  {m.read_at ? `lida ${timeAgo(m.read_at)}` : m.delivered_at ? `entregue ${timeAgo(m.delivered_at)}` : m.sent_at ? `enviada ${timeAgo(m.sent_at)}` : ""}
                </span>
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-primary hover:underline">Ver o texto enviado</summary>
                <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-surface-hover px-3 py-2 text-[13px]">{m.body}</p>
              </details>
              {m.error_detail && <p className="text-xs text-danger">{m.error_detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
