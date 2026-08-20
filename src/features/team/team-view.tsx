"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { changeMemberRole, inviteMember } from "@/actions/management";
import type { Role, User } from "@/types";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  sdr: "SDR",
  vendedor: "Vendedor",
  viewer: "Viewer",
};

const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Acesso total, incluindo faturamento",
  admin: "Acesso quase total",
  sdr: "Prospecção e qualificação",
  vendedor: "Leads e negociações",
  viewer: "Somente leitura",
};

export function TeamView({ members }: { members: User[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("sdr");

  async function submit() {
    setSaving(true);
    try {
      const res = await inviteMember(name, email, role);
      if (res.error) {
        toast(res.error, "error");
        return;
      }
      toast("Membro adicionado à equipe.");
      setOpen(false);
      setName("");
      setEmail("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus /> Convidar membro
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Convidar membro</DialogTitle>
              <DialogDescription>
                Em produção o convite é enviado por e-mail via Supabase Auth.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Nome</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>E-mail</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Papel</Label>
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as Role[])
                      .filter((r) => r !== "owner")
                      .map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABEL[r]} — {ROLE_DESCRIPTION[r]}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={submit} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} Convidar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {members.map((m) => (
          <Card key={m.id}>
            <CardContent className="flex items-center gap-3 p-4">
              <Avatar name={m.name} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.email}</p>
              </div>
              {m.role === "owner" ? (
                <Badge>Owner</Badge>
              ) : (
                <Select
                  value={m.role}
                  onValueChange={async (v) => {
                    const res = await changeMemberRole(m.id, v as Role);
                    if (res.error) toast(res.error, "error");
                    else {
                      toast("Papel atualizado.");
                      router.refresh();
                    }
                  }}
                >
                  <SelectTrigger className="h-8 w-32 text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as Role[])
                      .filter((r) => r !== "owner")
                      .map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-4">
          <h3 className="mb-2 text-[13px] font-semibold">Papéis e permissões</h3>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <p key={r} className="text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">{ROLE_LABEL[r]}:</span>{" "}
                {ROLE_DESCRIPTION[r]}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
