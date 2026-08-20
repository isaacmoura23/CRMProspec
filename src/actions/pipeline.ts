"use server";

import { revalidatePath } from "next/cache";
import { getDb, saveDb } from "@/lib/store";
import { uid } from "@/lib/utils";

export async function createStage(name: string): Promise<{ error?: string }> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return { error: "Nome muito curto." };
  const db = getDb();
  // insere antes das etapas de fechamento (ganho/perda)
  const terminalOrder = Math.min(
    ...db.pipeline_stages.filter((s) => s.is_won || s.is_lost).map((s) => s.order)
  );
  for (const s of db.pipeline_stages) {
    if (s.order >= terminalOrder) s.order += 1;
  }
  db.pipeline_stages.push({
    id: uid("stg"),
    organization_id: db.organization.id,
    name: trimmed,
    order: terminalOrder,
    color: null,
    is_won: false,
    is_lost: false,
  });
  saveDb();
  revalidatePath("/pipeline");
  return {};
}

export async function renameStage(stageId: string, name: string): Promise<void> {
  const db = getDb();
  const stage = db.pipeline_stages.find((s) => s.id === stageId);
  if (stage && name.trim().length >= 2) {
    stage.name = name.trim();
    saveDb();
    revalidatePath("/pipeline");
  }
}

export async function deleteStage(stageId: string): Promise<{ error?: string }> {
  const db = getDb();
  const stage = db.pipeline_stages.find((s) => s.id === stageId);
  if (!stage) return {};
  if (stage.is_won || stage.is_lost) return { error: "Etapas de fechamento não podem ser excluídas." };
  const inUse = db.leads.some((l) => !l.archived && l.pipeline_stage_id === stageId);
  if (inUse) return { error: "Mova os leads desta etapa antes de excluí-la." };
  db.pipeline_stages = db.pipeline_stages.filter((s) => s.id !== stageId);
  saveDb();
  revalidatePath("/pipeline");
  return {};
}

export async function moveStage(stageId: string, direction: "left" | "right"): Promise<void> {
  const db = getDb();
  const ordered = [...db.pipeline_stages].sort((a, b) => a.order - b.order);
  const idx = ordered.findIndex((s) => s.id === stageId);
  const swapIdx = direction === "left" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
  const a = ordered[idx]!;
  const b = ordered[swapIdx]!;
  [a.order, b.order] = [b.order, a.order];
  saveDb();
  revalidatePath("/pipeline");
}
