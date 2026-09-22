import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

// The database stores no career data, ever. This is the enforcement
// mechanism: an exact column allowlist per table, introspected from
// information_schema.columns. Adding any column to db/migrations/0001_init.sql
// without updating this allowlist deliberately fails this test.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  invites: ["created_at", "id", "token_hash", "used_at"],
  sessions: ["created_at", "display_name", "id", "invite_id", "revoked_at"],
  install_status: ["checked_at", "item", "session_id"],
};

async function columnsOf(db: Awaited<ReturnType<typeof createTestDb>>, table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name",
    [table],
  );
  return rows.map((row) => row.column_name);
}

describe("schema allowlist — no career data, ever", () => {
  it.each(Object.entries(EXPECTED_COLUMNS))("table %s has exactly the allowed columns", async (table, expected) => {
    const db = await createTestDb();
    const columns = await columnsOf(db, table);
    expect(columns).toEqual(expected);
  });

  it("has exactly three tables", async () => {
    const db = await createTestDb();
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    expect(rows.map((row) => row.table_name)).toEqual(["install_status", "invites", "sessions"]);
  });
});
