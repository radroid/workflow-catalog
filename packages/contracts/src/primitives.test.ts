import { describe, expect, it } from "vitest";
import {
  hexDigestSchema,
  httpUrlSchema,
  isoDateSchema,
  isoDateTimeSchema,
  semverSchema,
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
