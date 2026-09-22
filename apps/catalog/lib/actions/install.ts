"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db";
import { getActiveSession } from "../auth/require-session";
import { isInstallChecklistItemId, setInstallItemChecked } from "../install-status";

export async function toggleInstallItemAction(formData: FormData): Promise<void> {
  // Server Functions are reachable by direct POST — re-check the session
  // here rather than trusting that only the gated /install page can reach
  // this. No redirect on failure: an unauthenticated POST to this action
  // simply does nothing.
  const session = await getActiveSession();
  if (!session) return;

  const item = String(formData.get("item") ?? "");
  if (!isInstallChecklistItemId(item)) return;

  const checked = formData.get("checked") === "true";

  const db = await getDb();
  await setInstallItemChecked(db, session.id, item, checked);
  revalidatePath("/install");
}
