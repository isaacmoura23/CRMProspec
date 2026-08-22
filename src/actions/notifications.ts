"use server";

import { revalidatePath } from "next/cache";
import { getDb, saveDb } from "@/lib/store";
import { getCurrentUser } from "@/lib/auth";

export async function markNotificationRead(id: string) {
  const user = await getCurrentUser();
  const db = getDb();
  const n = db.notifications.find((n) => n.id === id && n.user_id === user.id);
  if (n) {
    n.read = true;
    saveDb();
    revalidatePath("/", "layout");
  }
}

export async function markAllNotificationsRead() {
  const user = await getCurrentUser();
  const db = getDb();
  db.notifications.forEach((n) => {
    if (n.user_id === user.id) n.read = true;
  });
  saveDb();
  revalidatePath("/", "layout");
}
