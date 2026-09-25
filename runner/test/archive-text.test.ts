import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractArchiveText } from "../lib/archive-text.ts";

/**
 * `archive-text.ts`'s own tests (P03.1 packet acceptance: "Fictional fixture
 * files (Ada Quill) in ... ZIP extract to the expected text"; "a zip bomb
 * ... give[s] [its] plain error"; "Nothing is written outside
 * sources/<category>/"; hostile-content "no tool other than extract_claims
 * called" is proven at the route level — this file proves entry paths are
 * never used as file paths, which is what makes that safe here). Every zip
 * here is built in memory with `fflate`, never read from or written to disk.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "..", "..", "packages", "job-assistant", "fixtures", "onboarding");

async function fixtureZip(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, "ada-quill-export.zip")));
}

describe("extractArchiveText: the fixture export", () => {
  it("extracts CSV, JSON, MD and TXT entries, skipping the binary entry", async () => {
    const result = await extractArchiveText(await fixtureZip());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entriesIncluded).toBe(4);
    expect(result.text).toContain("Ada Quill,Senior Platform Engineer at Northwind Labs,Remote");
    expect(result.text).toContain("Senior Platform Engineer");
    expect(result.text).toContain("Skills endorsed by connections");
    expect(result.text).not.toContain("Photos/avatar.jpg");
    expect(result.text).not.toContain("not really a jpeg");
  });

  it("labels each entry with '## <name>', and never as a file path (no path separator reaches the filesystem)", async () => {
    const result = await extractArchiveText(await fixtureZip());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toMatch(/^## Profile\.csv$/m);
    expect(result.text).toMatch(/^## Positions\.json$/m);
  });
});

describe("extractArchiveText: malformed and empty", () => {
  it("refuses bytes that aren't a zip at all with 'malformed'", async () => {
    const result = await extractArchiveText(new TextEncoder().encode("not a zip file"));
    expect(result).toEqual({ ok: false, reason: "malformed", message: "That archive can't be read. It may be damaged, or not really a zip file." });
  });

  it("refuses an archive with no CSV/TXT/MD/JSON entries with 'empty'", async () => {
    const onlyImages = zipSync({ "photo.jpg": strToU8("binary-ish content") });
    const result = await extractArchiveText(onlyImages);
    expect(result).toEqual({ ok: false, reason: "empty", message: "That archive has no CSV, TXT, MD or JSON entries to read." });
  });

  it("refuses an oversized archive file with 'too_large', without ever unzipping it", async () => {
    const oversized = new Uint8Array(11 * 1024 * 1024);
    const result = await extractArchiveText(oversized, { maxBytes: 10 * 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "too_large", message: "That archive is larger than 10 MB." });
  });
});

describe("extractArchiveText: caps and the zip-bomb guard", () => {
  it("refuses an archive with too many entries", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 10; i += 1) files[`note-${i}.txt`] = strToU8("hi");
    const archive = zipSync(files);
    const result = await extractArchiveText(archive, { maxEntries: 5 });
    expect(result).toEqual({ ok: false, reason: "zip_bomb", message: "That archive has more than 5 entries." });
  });

  it("refuses a single entry over the per-entry uncompressed cap", async () => {
    const big = strToU8("x".repeat(200_000));
    const archive = zipSync({ "big.txt": big });
    // maxCompressionRatio raised out of the way: "x" repeated compresses at a very high ratio, which
    // would otherwise trip first and mask the per-entry-size check this test means to isolate.
    const result = await extractArchiveText(archive, { maxEntryBytes: 100_000, maxTotalBytes: 10_000_000, maxCompressionRatio: 1_000_000 });
    expect(result).toEqual({ ok: false, reason: "zip_bomb", message: "An entry in that archive is larger than 0 MB uncompressed." });
  });

  it("refuses when included entries' total uncompressed size crosses the cap", async () => {
    const archive = zipSync({ "a.txt": strToU8("x".repeat(60_000)), "b.txt": strToU8("y".repeat(60_000)) });
    const result = await extractArchiveText(archive, { maxEntryBytes: 100_000, maxTotalBytes: 100_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("zip_bomb");
  });

  it("refuses a realistic zip bomb: a huge repetitive payload that compresses down to almost nothing", async () => {
    // 50 MB of a single repeated byte compresses to well under 100 KB with plain deflate — a ratio far
    // past the 100:1 default, and a completely ordinary (non-adversarial) way to build one.
    const archive = zipSync({ "huge.csv": strToU8("A".repeat(50 * 1024 * 1024)) });
    const result = await extractArchiveText(archive);
    expect(result).toEqual({ ok: false, reason: "zip_bomb", message: "That archive decompresses far beyond its stored size (a zip-bomb guard)." });
  });

  it("a legitimate, moderately compressible text entry within every cap is accepted", async () => {
    // Varied prose (no long verbatim repeats) compresses at roughly 10-12x with plain deflate, nowhere
    // near the 100:1 zip-bomb ratio — unlike a single sentence or character repeated verbatim, which
    // deflate's LZ77 window collapses almost to nothing (that case is exactly the zip-bomb test above).
    const lines = Array.from(
      { length: 300 },
      (_unused, i) => `Note ${i}: Ada Quill reviewed application ${i * 7 + 3} for the Fernwood team on day ${i % 30}, outcome code ${(i * 13) % 97}.`,
    );
    const archive = zipSync({ "notes.txt": strToU8(lines.join("\n")) });
    const result = await extractArchiveText(archive);
    expect(result.ok).toBe(true);
  });

  it("a nested zip entry is never itself decompressed (its extension is not in the allowlist)", async () => {
    const inner = zipSync({ "a.txt": strToU8("A".repeat(50 * 1024 * 1024)) }); // would trip the ratio guard if inflated
    const archive = zipSync({ "nested.zip": inner, "notes.txt": strToU8("ordinary text, unrelated to the nested archive") });
    const result = await extractArchiveText(archive);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entriesIncluded).toBe(1); // only notes.txt; nested.zip was skipped by the extension gate, never inflated
    expect(result.text).toContain("ordinary text, unrelated to the nested archive");
  });

  it("a directory entry is skipped, not counted as a text entry", async () => {
    const archive = zipSync({ "folder/": new Uint8Array(0), "folder/notes.txt": strToU8("hello") });
    const result = await extractArchiveText(archive);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.entriesIncluded).toBe(1);
  });

  it("probe: fflate truncates a decompressed entry to its header's own declared size, never past it — the fact archive-text.ts's module doc relies on to check only declared sizes, before decompression, and still be sound against a header that lies small", async () => {
    const real = "B".repeat(500_000);
    const realSize = Buffer.byteLength(real, "utf8");
    const archive = Buffer.from(zipSync({ "lie.txt": strToU8(real) }));
    const lie = 10;
    let patched = 0;
    for (let i = 0; i + 4 <= archive.length; i += 1) {
      if (archive.readUInt32LE(i) === realSize) {
        archive.writeUInt32LE(lie, i);
        patched += 1;
      }
    }
    expect(patched).toBeGreaterThanOrEqual(2); // the local header's and the central directory's own copies, at least
    const { unzipSync } = await import("fflate");
    const output = unzipSync(new Uint8Array(archive));
    expect(output["lie.txt"]!.length).toBe(lie); // truncated to the (lied) declared size, not the real 500,000 bytes the stream would otherwise give
  });
});
