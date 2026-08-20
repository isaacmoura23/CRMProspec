"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/store";
import { clearSession, setSessionUser } from "@/lib/auth";

export async function loginAs(userId: string): Promise<void> {
  const db = getDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return;
  await setSessionUser(userId);
  redirect(db.onboarding_completed ? "/dashboard" : "/onboarding");
}

export async function logout(): Promise<void> {
  await clearSession();
  redirect("/login");
}
