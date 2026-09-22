import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { acceptInvite, checkInviteToken, createInvite, listInvites, MAX_INVITES } from "../lib/invites";
import { findActiveSession } from "../lib/sessions";

describe("invites", () => {
  it("five invites succeed and the sixth is refused", async () => {
    const db = await createTestDb();

    for (let i = 0; i < MAX_INVITES; i++) {
      const result = await createInvite(db);
      expect(result.ok).toBe(true);
    }

    const sixth = await createInvite(db);
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.reason).toMatch(/already exist/i);
    }

    const invites = await listInvites(db);
    expect(invites).toHaveLength(MAX_INVITES);
  });

  it("the slot cap is structural: a sixth row is refused even by direct SQL, not just by the service", async () => {
    const db = await createTestDb();

    for (let i = 0; i < MAX_INVITES; i++) {
      const result = await createInvite(db);
      expect(result.ok).toBe(true);
    }

    // Bypasses createInvite entirely — proves the UNIQUE/CHECK constraints
    // themselves reject a sixth row, not just the application-level guard
    // (see lib/invites.ts's createInvite comment: a `count(*) < 5` guard
    // alone races under Neon's READ COMMITTED isolation).
    await expect(
      db.query("INSERT INTO invites (id, token_hash, slot) VALUES ($1, $2, $3)", [
        "00000000-0000-4000-8000-000000000099",
        "direct-sql-attempt-hash",
        6,
      ]),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation: slot BETWEEN 1 AND 5

    // A colliding slot (re-using one already claimed) fails the other way.
    await expect(
      db.query("INSERT INTO invites (id, token_hash, slot) VALUES ($1, $2, $3)", [
        "00000000-0000-4000-8000-000000000098",
        "direct-sql-attempt-hash-2",
        1,
      ]),
    ).rejects.toMatchObject({ code: "23505" }); // unique_violation

    const invites = await listInvites(db);
    expect(invites).toHaveLength(MAX_INVITES);
  });

  it("issues tokens that are single-use and unpredictable", async () => {
    const db = await createTestDb();
    const a = await createInvite(db);
    const b = await createInvite(db);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.token).not.toEqual(b.token);
      // base64url, >=128 bits -> >=22 chars once padding is stripped.
      expect(a.token.length).toBeGreaterThanOrEqual(22);
    }
  });

  it("a used link is refused", async () => {
    const db = await createTestDb();
    const created = await createInvite(db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await acceptInvite(db, created.token, "Ada Quill");
    expect(first.ok).toBe(true);

    const second = await acceptInvite(db, created.token, "Sam Fernwood");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toMatch(/invalid or has already been used/i);
    }
  });

  it("an unknown token is refused with the same message as a used one", async () => {
    const db = await createTestDb();
    const result = await acceptInvite(db, "not-a-real-token", "Ravi Harbor");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid or has already been used/i);
    }
  });

  it("checkInviteToken reflects valid/used/unknown without mutating anything", async () => {
    const db = await createTestDb();
    const created = await createInvite(db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await checkInviteToken(db, created.token)).toBe("valid");
    expect(await checkInviteToken(db, "unknown-token")).toBe("invalid");

    await acceptInvite(db, created.token, "Ada Quill");
    expect(await checkInviteToken(db, created.token)).toBe("invalid");
  });

  it("concurrent acceptance of one token yields exactly one session", async () => {
    const db = await createTestDb();
    const created = await createInvite(db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [a, b] = await Promise.all([
      acceptInvite(db, created.token, "Ada Quill"),
      acceptInvite(db, created.token, "Sam Fernwood"),
    ]);

    const outcomes = [a, b];
    const succeeded = outcomes.filter((r) => r.ok);
    const refused = outcomes.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM sessions");
    expect(rows[0]?.count).toBe("1");

    if (succeeded[0]?.ok) {
      const session = await findActiveSession(db, succeeded[0].sessionId);
      expect(session).not.toBeNull();
    }
  });

  it("rejects a display name outside 1-40 characters or with control characters", async () => {
    const db = await createTestDb();
    const created = await createInvite(db);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const tooLong = "x".repeat(41);
    const result = await acceptInvite(db, created.token, tooLong);
    expect(result.ok).toBe(false);

    // The invite must still be unused after a rejected display name.
    expect(await checkInviteToken(db, created.token)).toBe("valid");

    const withControlChar = `Ada${String.fromCharCode(7)}Quill`;
    const result2 = await acceptInvite(db, created.token, withControlChar);
    expect(result2.ok).toBe(false);
  });
});
