import { describe, expect, it } from "vitest";
import { abbreviateUuid, formatTimestamp } from "./format";

describe("formatTimestamp", () => {
  it("formats a real ISO datetime as a human-readable string, not the raw ISO string", () => {
    const formatted = formatTimestamp("2026-09-22T09:31:00.000Z");
    expect(formatted).not.toBe("2026-09-22T09:31:00.000Z");
    expect(formatted).toMatch(/2026/);
  });

  it("falls back to the raw string instead of throwing on an unparseable value", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
  });
});

describe("abbreviateUuid", () => {
  it("shortens a UUID to its first 8 characters plus an ellipsis", () => {
    expect(abbreviateUuid("b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10")).toBe("b6f3a5d2…");
  });

  it("returns a short string unchanged (never crashes on non-UUID input)", () => {
    expect(abbreviateUuid("short")).toBe("short");
  });
});
