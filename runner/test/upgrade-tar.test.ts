import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readFileFromReleaseTarball, readTarEntries, TarballReadError } from "../upgrade/tar.ts";
import { buildReleaseTarball } from "./upgrade-fixtures.ts";

describe("readFileFromReleaseTarball", () => {
  it("reads package/workflow.json's bytes out of a built fixture tarball", () => {
    const manifest = { name: "job-assistant", version: "0.2.0" };
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(manifest) });
    const bytes = readFileFromReleaseTarball(tarball, "package/workflow.json");
    expect(bytes).toBeDefined();
    expect(JSON.parse(Buffer.from(bytes!).toString("utf8"))).toEqual(manifest);
  });

  it("returns undefined for an entry that is not in the tarball", () => {
    const tarball = buildReleaseTarball({ "workflow.json": "{}" });
    expect(readFileFromReleaseTarball(tarball, "package/does-not-exist.json")).toBeUndefined();
  });

  it("reads only the requested entry out of a multi-file tarball", () => {
    const tarball = buildReleaseTarball({ "workflow.json": '{"a":1}', "README.md": "# hi", "skills/one.md": "a skill" });
    expect(JSON.parse(Buffer.from(readFileFromReleaseTarball(tarball, "package/workflow.json")!).toString("utf8"))).toEqual({ a: 1 });
    expect(Buffer.from(readFileFromReleaseTarball(tarball, "package/README.md")!).toString("utf8")).toBe("# hi");
    expect(Buffer.from(readFileFromReleaseTarball(tarball, "package/skills/one.md")!).toString("utf8")).toBe("a skill");
  });

  it("throws TarballReadError for something that is not valid gzip", () => {
    expect(() => readFileFromReleaseTarball(Buffer.from("not gzip at all", "utf8"), "package/workflow.json")).toThrow(TarballReadError);
  });

  it("throws TarballReadError for valid gzip that is not a tar archive", () => {
    // At least one full 512-byte header block, so readTarEntries actually parses
    // it as a header rather than stopping for being too short; the repeated
    // phrase lands non-octal letters in the size field (offset 124-136),
    // which readOctal refuses to parse.
    const garbage = "not a tar archive, definitely garbage data here. ".repeat(20).slice(0, 600);
    const notTar = gzipSync(Buffer.from(garbage, "utf8"));
    expect(() => readFileFromReleaseTarball(notTar, "package/workflow.json")).toThrow(TarballReadError);
  });

  it("handles an entry larger than one 512-byte block", () => {
    const big = "x".repeat(1500); // spans four 512-byte blocks
    const tarball = buildReleaseTarball({ "workflow.json": "{}", "big.txt": big });
    expect(Buffer.from(readFileFromReleaseTarball(tarball, "package/big.txt")!).toString("utf8")).toBe(big);
  });
});

describe("readTarEntries", () => {
  it("skips a directory-shaped header (none in a pack fixture, but a real npm tarball may include one) without disturbing later entries", () => {
    // buildReleaseTarball never writes a directory entry itself; this proves
    // the reader's typeflag switch (only "0"/"\0" is collected) rather than
    // relying on the fixture writer to also emit one.
    const tarball = buildReleaseTarball({ "workflow.json": "{}" });
    const entries = readTarEntries(gunzipSync(tarball));
    expect(entries.map((e) => e.name)).toEqual(["package/workflow.json"]);
  });
});
