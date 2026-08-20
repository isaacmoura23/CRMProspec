"use server";

import { revalidatePath } from "next/cache";
import { getDb, saveDb } from "@/lib/store";

export async function markNotificationRead(id: string) {
  const db = getDb();
  const n = db.notifications.find((n) => n.id === id);
  if (n) {
    n.read = true;
    saveDb();
    revalidatePath("/", "layout");
  }
}

export async function markAllNotificationsRead() {
  const db = getDb();
  db.notifications.forEach((n) => (n.read = true));
  saveDb();
  revalidatePath("/", "layout");
}
