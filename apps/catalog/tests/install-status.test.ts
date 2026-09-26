import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { acceptInvite, createInvite } from "../lib/invites";
import {
  INSTALL_CHECKLIST_ITEMS,
  isInstallChecklistItemId,
  listCheckedItems,
  setInstallItemChecked,
} from "../lib/install-status";

async function sessionId(db: Awaited<ReturnType<typeof createTestDb>>): Promise<string> {
  const created = await createInvite(db);
  if (!created.ok) throw new Error("test setup: createInvite failed");
  const accepted = await acceptInvite(db, created.token, "Ada Quill");
  if (!accepted.ok) throw new Error("test setup: acceptInvite failed");
  return accepted.sessionId;
}

describe("install checklist — no free text, per session", () => {
  it("starts with nothing checked", async () => {
    const db = await createTestDb();
    const id = await sessionId(db);
    expect(await listCheckedItems(db, id)).toEqual(new Set());
  });

  it("checking an item persists it, and is idempotent", async () => {
    const db = await createTestDb();
    const id = await sessionId(db);

    await setInstallItemChecked(db, id, "node", true);
    await setInstallItemChecked(db, id, "node", true); // idempotent, no error, no duplicate row.

    expect(await listCheckedItems(db, id)).toEqual(new Set(["node"]));
  });

  it("unchecking an item removes it, and is idempotent", async () => {
    const db = await createTestDb();
    const id = await sessionId(db);

    await setInstallItemChecked(db, id, "runner", true);
    await setInstallItemChecked(db, id, "runner", false);
    await setInstallItemChecked(db, id, "runner", false); // idempotent.

    expect(await listCheckedItems(db, id)).toEqual(new Set());
  });

  it("checklist state is per session, not shared", async () => {
    const db = await createTestDb();
    const idA = await sessionId(db);
    const idB = await sessionId(db);

    await setInstallItemChecked(db, idA, "workspace", true);

    expect(await listCheckedItems(db, idA)).toEqual(new Set(["workspace"]));
    expect(await listCheckedItems(db, idB)).toEqual(new Set());
  });

  it("the database CHECK constraint rejects a free-text item value", async () => {
    const db = await createTestDb();
    const id = await sessionId(db);

    await expect(
      db.query("INSERT INTO install_status (session_id, item) VALUES ($1, $2)", [id, "some free text"]),
    ).rejects.toThrow();
  });

  it("isInstallChecklistItemId accepts exactly the five known ids", () => {
    for (const item of INSTALL_CHECKLIST_ITEMS) {
      expect(isInstallChecklistItemId(item.id)).toBe(true);
    }
    expect(isInstallChecklistItemId("free text is not allowed")).toBe(false);
    expect(isInstallChecklistItemId("")).toBe(false);
  });
});
