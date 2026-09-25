import { describe, expect, it } from "vitest";
import { parseChecksumFile, sha256Hex, verifyChecksum } from "../upgrade/checksum.ts";

describe("parseChecksumFile", () => {
  it("parses a sha256sum-format line (two spaces between hex and filename)", () => {
    const hex = "a".repeat(64);
    expect(parseChecksumFile(`${hex}  job-assistant-0.2.0.tgz\n`)).toEqual({ hex, filename: "job-assistant-0.2.0.tgz" });
  });

  it("lowercases the hex digest", () => {
    const hex = "A".repeat(64);
    expect(parseChecksumFile(`${hex}  file.tgz`)?.hex).toBe("a".repeat(64));
  });

  it("accepts sha256sum's optional binary-mode '*' marker", () => {
    const hex = "b".repeat(64);
    expect(parseChecksumFile(`${hex} *file.tgz`)).toEqual({ hex, filename: "file.tgz" });
  });

  it("returns undefined for text that is not the expected form", () => {
    expect(parseChecksumFile("")).toBeUndefined();
    expect(parseChecksumFile("not a checksum line")).toBeUndefined();
    expect(parseChecksumFile("deadbeef  too-short-hex.tgz")).toBeUndefined();
  });
});

describe("verifyChecksum", () => {
  it("passes when the tarball's sha256 matches the .sha256 file", () => {
    const bytes = Buffer.from("fictional tarball bytes", "utf8");
    const hex = sha256Hex(bytes);
    expect(verifyChecksum(bytes, `${hex}  job-assistant-0.2.0.tgz\n`).ok).toBe(true);
  });

  it("refuses when the digest does not match (the checksum-mismatch case)", () => {
    const bytes = Buffer.from("fictional tarball bytes", "utf8");
    const wrongHex = "0".repeat(64);
    const result = verifyChecksum(bytes, `${wrongHex}  job-assistant-0.2.0.tgz\n`);
    expect(result.ok).toBe(false);
  });

  it("refuses (with a parseError, not a thrown exception) when the .sha256 asset is not the expected form", () => {
    const bytes = Buffer.from("fictional tarball bytes", "utf8");
    const result = verifyChecksum(bytes, "this is not a checksum file");
    expect(result.ok).toBe(false);
    expect(result.parseError).toBeTruthy();
  });
});
