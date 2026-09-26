import type { Db } from "./db/types";

/**
 * The five checklist items, mirroring the runner's `npm run doctor` output
 * (spec F3). This is the allowlist: `item` has no free text, ever — the
 * database CHECK constraint (db/migrations/0001_init.sql) enforces the same
 * five values as defense in depth.
 */
export const INSTALL_CHECKLIST_ITEMS = [
  { id: "node", label: "Node 24 present" },
  { id: "runner", label: "Runner installed" },
  { id: "provider", label: "Provider connected" },
  { id: "workspace", label: "Workspace chosen" },
  { id: "extension", label: "Extension paired" },
] as const;

export type InstallChecklistItemId = (typeof INSTALL_CHECKLIST_ITEMS)[number]["id"];

const VALID_ITEM_IDS: ReadonlySet<string> = new Set(INSTALL_CHECKLIST_ITEMS.map((item) => item.id));

export function isInstallChecklistItemId(value: string): value is InstallChecklistItemId {
  return VALID_ITEM_IDS.has(value);
}

/** The set of item ids this session has ticked. */
export async function listCheckedItems(db: Db, sessionId: string): Promise<Set<InstallChecklistItemId>> {
  const { rows } = await db.query<{ item: string }>("SELECT item FROM install_status WHERE session_id = $1", [
    sessionId,
  ]);
  return new Set(rows.map((row) => row.item as InstallChecklistItemId));
}

/** Idempotent either way: ticking an already-ticked item, or unticking an already-unticked one, is a no-op. */
export async function setInstallItemChecked(
  db: Db,
  sessionId: string,
  item: InstallChecklistItemId,
  checked: boolean,
): Promise<void> {
  if (checked) {
    await db.query(
      "INSERT INTO install_status (session_id, item) VALUES ($1, $2) ON CONFLICT (session_id, item) DO NOTHING",
      [sessionId, item],
    );
  } else {
    await db.query("DELETE FROM install_status WHERE session_id = $1 AND item = $2", [sessionId, item]);
  }
}
