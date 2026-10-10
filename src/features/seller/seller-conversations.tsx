"use client";

import * as React from "react";
import Link from "next/link";
import { CalendarCheck, HandHelping, Loader2, MessageCircle, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dismissAttention, returnConversation, saveConversationConfig, setMeetingStatus, takeOverConversation } from "@/actions/agents";
import { useAgentAction } from "@/features/agents/controls";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { SellerConfig } from "@/agents/config";
import type { ConversationRow, MeetingRow } from "@/services/outreach/panel";
import type { MeetingStatus, OwnerNoticeStatus } from "@/types/agents";

const CLASS_LABEL: Record<string, string> = {
  interessado: "Interessado",
  quer_saber_mais: "Quer saber mais",
  preco: "Perguntou preço",
  sem_interesse: "Sem interesse",
  sem_prioridade: "Sem prioridade",
  ja_possui_fornecedor: "Já tem fornecedor",
  quer_reuniao: "Quer reunião",
  quer_proposta: "Quer proposta",
  pediu_retorno_futuro: "Pediu retorno futuro",
  informacao_insuficiente: "Mensagem vaga",
  outra: "Outra",
  pede_parada: "Pediu para parar",
  reuniao_marcada: "Reunião marcada",
};

function ConversationItem({ row, canWrite, attention }: { row: ConversationRow; canWrite: boolean; attention?: boolean }) {
  const { run, pending } = useAgentAction();
  const human = row.control === "humano";
  return (
    <li className="space-y-1.5 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leads/${row.lead_id}`} className="text-[13px] font-medium hover:underline">
          {row.lead_name}
        </Link>
        <Badge variant={human ? "info" : "neutral"}>{human ? "Com você" : "Com o agente"}</Badge>
        {row.last_classification && <Badge variant="outline">{CLASS_LABEL[row.last_classification] ?? row.last_classification}</Badge>}
        {row.awaiting === "horario" && <Badge variant="warning">Esperando a escolha do horário</Badge>}
        {row.unread && row.last_direction === "in" && <Badge variant="good">Nova</Badge>}
        {row.last_inbound_at && <span className="ml-auto text-xs text-muted-foreground">{timeAgo(row.last_inbound_at)}</span>}
      </div>
      {attention && row.attention_reason && <p className="text-xs text-warning">{row.attention_reason}</p>}
      {!attention && human && row.control_reason && <p className="text-xs text-muted-foreground">{row.control_reason}</p>}
      {row.last_text && (
        <p className="line-clamp-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{row.last_direction === "in" ? "Lead: " : "Você/agente: "}</span>
          {row.last_text}
        </p>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Link href="/conversas" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:underline">
            <MessageCircle className="size-3.5" /> Abrir conversa
          </Link>
          {human ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => returnConversation(row.lead_id))}>
              {pending ? <Loader2 className="animate-spin" /> : <UserCheck />} Devolver ao agente
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => takeOverConversation(row.lead_id))}>
              {pending ? <Loader2 className="animate-spin" /> : <HandHelping />} Assumir conversa
            </Button>
          )}
          {attention && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => dismissAttention(row.lead_id))}>
              Já resolvi
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function ConversationsPanel({ attention, recent, canWrite }: { attention: ConversationRow[]; recent: ConversationRow[]; canWrite: boolean }) {
  const attentionIds = new Set(attention.map((a) => a.lead_id));
  const others = recent.filter((r) => !attentionIds.has(r.lead_id));
  return (
    <div className="space-y-6">
      {attention.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>Precisam de você ({attention.length})</CardTitle>
            <CardDescription>O agente não sabe responder com segurança a estas conversas e parou. Responda pelo WhatsApp ou assuma a conversa por aqui.</CardDescription>
          </CardHeader>
          <ul className="divide-y divide-border">
            {attention.map((r) => (
              <ConversationItem key={r.lead_id} row={r} canWrite={canWrite} attention />
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Conversas</CardTitle>
          <CardDescription>
            O que os leads responderam, e quem conduz cada conversa. Se você escrever pelo celular, o agente para de escrever naquele lead sozinho; “Assumir” faz o mesmo por aqui.
          </CardDescription>
        </CardHeader>
        {others.length === 0 ? (
          <CardContent>
            <p className="text-[13px] text-muted-foreground">Nenhuma resposta de lead ainda.</p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {others.map((r) => (
              <ConversationItem key={r.lead_id} row={r} canWrite={canWrite} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const MEETING_LABEL: Record<MeetingStatus, string> = { agendada: "Agendada", realizada: "Realizada", cancelada: "Cancelada" };
const MEETING_BADGE: Record<MeetingStatus, "info" | "good" | "outline"> = { agendada: "info", realizada: "good", cancelada: "outline" };
const NOTICE_LABEL: Record<OwnerNoticeStatus, string> = {
  pendente: "Aviso no seu WhatsApp: aguardando envio",
  enviado: "Aviso enviado ao seu WhatsApp",
  falhou: "Aviso ao seu WhatsApp falhou",
  incerto: "Aviso ao seu WhatsApp sem confirmação",
};

function MeetingItem({ m, canWrite, ownerPhoneSet }: { m: MeetingRow; canWrite: boolean; ownerPhoneSet: boolean }) {
  const { run, pending } = useAgentAction();
  return (
    <li className="space-y-1.5 px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leads/${m.lead_id}`} className="text-[13px] font-medium hover:underline">
          {m.lead_name}
        </Link>
        <Badge variant={MEETING_BADGE[m.status]}>{MEETING_LABEL[m.status]}</Badge>
        <span className="ml-auto text-xs font-medium tabular-nums">{formatDateTime(m.at)}</span>
      </div>
      {m.interest_text && <p className="line-clamp-2 text-[13px] text-muted-foreground">Disse: “{m.interest_text}”</p>}
      <p className={`text-xs ${m.notice?.status === "falhou" || m.notice?.status === "incerto" ? "text-warning" : "text-muted-foreground"}`}>
        {m.notice
          ? `${NOTICE_LABEL[m.notice.status]}${m.notice.error && m.notice.status !== "enviado" ? `: ${m.notice.error}` : ""}.`
          : ownerPhoneSet
            ? "Sem aviso no seu WhatsApp (a reunião é anterior à configuração)."
            : "Sem aviso no WhatsApp: configure o seu número abaixo. O sino avisou."}
      </p>
      {canWrite && m.status === "agendada" && (
        <div className="flex gap-2 pt-0.5">
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setMeetingStatus(m.id, "realizada"))}>
            {pending ? <Loader2 className="animate-spin" /> : <CalendarCheck />} Marcar como realizada
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setMeetingStatus(m.id, "cancelada"))}>
            Cancelar
          </Button>
        </div>
      )}
    </li>
  );
}

export function MeetingsPanel({ meetings, canWrite, ownerPhoneSet }: { meetings: MeetingRow[]; canWrite: boolean; ownerPhoneSet: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reuniões</CardTitle>
        <CardDescription>Marcadas pelo Vendedor quando o lead escolhe um dos horários propostos. Cada uma vira uma tarefa no CRM e um aviso no sino e no seu WhatsApp.</CardDescription>
      </CardHeader>
      {meetings.length === 0 ? (
        <CardContent>
          <p className="text-[13px] text-muted-foreground">Nenhuma reunião marcada ainda.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {meetings.map((m) => (
            <MeetingItem key={m.id} m={m} canWrite={canWrite} ownerPhoneSet={ownerPhoneSet} />
          ))}
        </ul>
      )}
    </Card>
  );
}

const WEEKDAYS: Array<[number, string]> = [
  [1, "Seg"],
  [2, "Ter"],
  [3, "Qua"],
  [4, "Qui"],
  [5, "Sex"],
  [6, "Sáb"],
  [7, "Dom"],
];

export function ConversationConfigForm({ config, canAdmin }: { config: SellerConfig; canAdmin: boolean }) {
  const { run, pending } = useAgentAction();
  const [days, setDays] = React.useState<number[]>(config.meeting_days);
  const [start, setStart] = React.useState(String(config.meeting_start_hour));
  const [end, setEnd] = React.useState(String(config.meeting_end_hour));
  const [notice, setNotice] = React.useState(String(config.meeting_min_notice_hours));
  const [duration, setDuration] = React.useState(String(config.meeting_duration_min));
  const [ownerPhone, setOwnerPhone] = React.useState(config.owner_phone ?? "");

  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  const field = (label: string, value: string, set: (v: string) => void, min: number, max: number, hint?: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => set(e.target.value)} disabled={!canAdmin} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  function save() {
    run(() =>
      saveConversationConfig({
        meeting_days: days,
        meeting_start_hour: Number(start),
        meeting_end_hour: Number(end),
        meeting_min_notice_hours: Number(notice),
        meeting_duration_min: Number(duration),
        owner_phone: ownerPhone,
      })
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reuniões e aviso ao seu WhatsApp</CardTitle>
        <CardDescription>
          Quando o lead demonstra interesse, o Vendedor propõe dois horários dentro desta disponibilidade (fuso de São Paulo). Quando um é escolhido, o aviso chega ao seu
          WhatsApp pessoal, além do sino.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2" disabled={!canAdmin}>
          <legend className="text-sm font-medium">Dias e horário das reuniões</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map(([d, label]) => (
              <label
                key={d}
                className={`cursor-pointer rounded-lg border px-3 py-1 text-[13px] ${days.includes(d) ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-muted-foreground"}`}
              >
                <input type="checkbox" className="sr-only" checked={days.includes(d)} onChange={() => toggleDay(d)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {field("Reuniões a partir das (hora)", start, setStart, 0, 23)}
          {field("Reuniões até as (hora)", end, setEnd, 1, 24)}
          {field("Antecedência mínima (h)", notice, setNotice, 1, 168, "Tempo entre a resposta do lead e o primeiro horário proposto.")}
          {field("Duração (min)", duration, setDuration, 10, 120)}
        </div>
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="owner-phone">Seu WhatsApp para o aviso de reunião</Label>
          <Input id="owner-phone" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="(41) 99999-8888" disabled={!canAdmin} />
          <p className="text-xs text-muted-foreground">
            Número pessoal que recebe o aviso, enviado pelo número de prospecção. Se essa conexão cair, o aviso não sai — por isso o sino também avisa. Vazio = só o sino.
          </p>
        </div>
        {canAdmin && (
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Salvar reuniões e aviso
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
