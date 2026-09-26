import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  boundedHttpUrlSchema,
  hexDigestSchema,
  httpUrlSchema,
  isoDateSchema,
  isoDateTimeSchema,
  semverSchema,
  utf8BoundedTextSchema,
  uuidSchema,
} from "./primitives";

describe("uuidSchema", () => {
  it("accepts a v4 UUID", () => {
    expect(uuidSchema.parse("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    );
  });

  it("rejects a non-UUID string", () => {
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("httpUrlSchema", () => {
  it("accepts https and http URLs", () => {
    expect(httpUrlSchema.safeParse("https://jobs.example/posting/1").success).toBe(true);
    expect(httpUrlSchema.safeParse("http://jobs.example/posting/1").success).toBe(true);
  });

  // docs/spec/research/browser-boundary.md: "reject javascript:, local
  // files, privileged browser URLs, and arbitrary code."
  it.each(["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "chrome-extension://abc/x"])(
    "rejects %s",
    (url) => {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    },
  );

  // P01.1 packet, deliverable 1: rejects surrounding whitespace outright
  // rather than trimming it away and accepting the trimmed value.
  it.each([
    "  https://jobs.example/x",
    "https://jobs.example/x  ",
    "\thttps://jobs.example/x",
    "https://jobs.example/x\t",
    "\nhttps://jobs.example/x",
  ])("rejects %j (surrounding whitespace) instead of trimming it", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });

  // A well-formed URL: non-empty host, no embedded space.
  it.each(["https://", "http://", "https://exa mple.com/"])("rejects %j", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });

  it("accepts ports, paths, queries and IDN hosts", () => {
    expect(httpUrlSchema.safeParse("https://jobs.example:8080/posting/1?ref=board").success).toBe(true);
    expect(httpUrlSchema.safeParse("https://xn--exmple-cua.com/").success).toBe(true);
  });
});

describe("boundedHttpUrlSchema", () => {
  const bounded = boundedHttpUrlSchema(64);

  it.each([
    "https://jobs.example/posting/1",
    "http://jobs.example/x",
    "  https://jobs.example/x  ",
    "https://jobs.example/a\tb",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "chrome://settings",
    "chrome-extension://abc/x",
    "https:/jobs.example",
    "not a url",
  ])("agrees with httpUrlSchema on %j when within the cap", (url) => {
    const boundedResult = bounded.safeParse(url);
    const plainResult = httpUrlSchema.safeParse(url);
    expect(boundedResult.success).toBe(plainResult.success);
    expect(boundedResult.data).toBe(plainResult.data);
  });

  // P01.1: httpUrlSchema itself now rejects surrounding whitespace, so
  // trailing-space padding no longer demonstrates "a naive .max() measures
  // the rewritten value" (both now reject it, for the same reason). An
  // embedded tab isn't surrounding whitespace — httpUrlSchema accepts it,
  // silently dropping the tab (zod's URL check deletes embedded tab/CR/LF
  // from the whole string) — so it still isolates the raw-vs-rewritten-value
  // distinction a naively appended `.max()` gets wrong.
  it("counts the raw input, not the value zod's URL check rewrites (embedded tabs stripped)", () => {
    const padded = `https://jobs.example/p${"\t".repeat(64)}q`;
    expect(httpUrlSchema.max(64).safeParse(padded).success).toBe(true);
    expect(bounded.safeParse(padded).success).toBe(false);
  });

  it("emits httpUrlSchema's JSON Schema plus maxLength", () => {
    expect(z.toJSONSchema(bounded)).toEqual({ ...z.toJSONSchema(httpUrlSchema), maxLength: 64 });
  });
});

describe("utf8BoundedTextSchema", () => {
  const schema = utf8BoundedTextSchema(10);

  it.each([
    ["8 ASCII letters", "a".repeat(8), 10, true],
    ["9 ASCII letters", "a".repeat(9), 11, false],
    ["4 double quotes", '"'.repeat(4), 10, true],
    ["5 double quotes", '"'.repeat(5), 12, false],
    ["one U+0001", "\u0001", 8, true],
    ["two U+0001", "\u0001\u0001", 14, false],
    ["two 3-byte CJK", "字字", 8, true],
    ["two 4-byte emoji", "\u{1F600}\u{1F600}", 10, true],
  ] as Array<[string, string, number, boolean]>)(
    "%s: %j is %i bytes as JSON, valid = %s",
    (_label, value, jsonBytes, valid) => {
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBe(jsonBytes);
      expect(schema.safeParse(value).success).toBe(valid);
    },
  );

  it("emits maxLength = maxBytes - 2 and a description of where the byte bound is enforced", () => {
    const json = z.toJSONSchema(schema) as { maxLength?: number; description?: string };
    expect(json.maxLength).toBe(8);
    expect(json.description).toContain("zod");
    expect(json.description).toContain("256 KB");
  });
});

describe("isoDateTimeSchema", () => {
  it("accepts Date#toISOString() output", () => {
    expect(isoDateTimeSchema.safeParse(new Date().toISOString()).success).toBe(true);
  });

  it("accepts an explicit numeric offset", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-22T01:23:45+05:30").success).toBe(true);
  });

  it("rejects a timezone-less local datetime", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-22T01:23:45").success).toBe(false);
  });

  it("rejects a bare date", () => {
    expect(isoDateTimeSchema.safeParse("2026-09-22").success).toBe(false);
  });
});

describe("isoDateSchema", () => {
  it("accepts a calendar date", () => {
    expect(isoDateSchema.safeParse("2026-09-22").success).toBe(true);
  });

  it("rejects a full datetime", () => {
    expect(isoDateSchema.safeParse("2026-09-22T00:00:00Z").success).toBe(false);
  });
});

describe("semverSchema", () => {
  it("accepts a plain semver", () => {
    expect(semverSchema.safeParse("0.1.0").success).toBe(true);
  });

  it("accepts a prerelease/build metadata semver", () => {
    expect(semverSchema.safeParse("1.2.3-beta.1+build.5").success).toBe(true);
  });

  it.each(["1.2", "v1.2.3", "1.2.3.4", "latest"])("rejects %s", (value) => {
    expect(semverSchema.safeParse(value).success).toBe(false);
  });
});

describe("hexDigestSchema", () => {
  it("accepts a sha256 hex digest", () => {
    expect(
      hexDigestSchema.safeParse("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        .success,
    ).toBe(true);
  });

  it("rejects a non-hex string", () => {
    expect(hexDigestSchema.safeParse("not-a-hash!!").success).toBe(false);
  });

  it("rejects a too-short string", () => {
    expect(hexDigestSchema.safeParse("abc").success).toBe(false);
  });
});
