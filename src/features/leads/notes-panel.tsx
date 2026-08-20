"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/ui/avatar";
import { addNote } from "@/actions/leads";
import { formatDateTime } from "@/lib/format";
import type { Note, User } from "@/types";

export function NotesPanel({
  leadId,
  notes,
  users,
}: {
  leadId: string;
  notes: Note[];
  users: User[];
}) {
  const router = useRouter();
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function submit() {
    if (!content.trim()) return;
    setSaving(true);
    try {
      await addNote(leadId, content);
      setContent("");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Ex.: Cliente disse que precisa conversar com o sócio antes de decidir."
        />
        <Button size="sm" onClick={submit} disabled={saving || !content.trim()}>
          {saving && <Loader2 className="animate-spin" />} Adicionar nota
        </Button>
      </div>

      {notes.length === 0 ? (
        <p className="flex items-center gap-2 py-4 text-[13px] text-muted-foreground">
          <StickyNote className="size-4" /> Nenhuma nota interna ainda.
        </p>
      ) : (
        <div className="space-y-3">
          {[...notes]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map((note) => {
              const author = users.find((u) => u.id === note.author_id);
              return (
                <div key={note.id} className="flex gap-3 rounded-lg border border-border p-3.5">
                  <Avatar name={author?.name ?? "?"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium">{author?.name ?? "Usuário"}</span>
                      <span className="text-[11px] text-faint-foreground">
                        {formatDateTime(note.created_at)}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted-foreground">
                      {note.content}
                    </p>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
