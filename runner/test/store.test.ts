import { readFile, readdir, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { workspaceManifestSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { createFileExclusive, readJsonFile, writeFileAtomic } from "../store/atomic.ts";
import { EventJournal } from "../store/journal.ts";
import { readModelCheck, writeModelCheck } from "../store/model-check.ts";
import { RUNNER_STATE_DIRECTORIES, WORKSPACE_DIRECTORIES, Workspace, WorkspaceError, WorkspacePathError } from "../store/workspace.ts";
import { jobCapture, newWorkspace, tempDir } from "./helpers.ts";

describe("atomic writes", () => {
  it("replaces a file in one step, mode 0600, leaving no temp files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "record.json");
    await writeFileAtomic(file, "one");
    await writeFileAtomic(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["record.json"]);
  });

  it("creates exclusively: a second create of the same file loses and writes nothing", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "event.json");
    const results = await Promise.all([createFileExclusive(file, "first"), createFileExclusive(file, "second")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(file, "utf8"));
    expect(await createFileExclusive(file, "third")).toBe(false);
    expect(await readdir(dir)).toEqual(["event.json"]);
  });

  it("reads a missing JSON file as undefined", async () => {
    expect(await readJsonFile(path.join(await tempDir(), "missing.json"))).toBeUndefined();
  });
});

describe("workspace", () => {
  it("creates workspace.json that matches the contract, and the spec §5 directories", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const manifest = workspaceManifestSchema.parse(JSON.parse(await readFile(path.join(workspace.root, "workspace.json"), "utf8")));
    expect(manifest).toEqual(workspace.manifest);
    expect(manifest.packageVersion).toBe("0.1.0");
    expect(manifest.createdAt).toBe(clock.now().toISOString());
    const entries = await readdir(workspace.root);
    for (const name of WORKSPACE_DIRECTORIES) expect(entries).toContain(name);
    for (const name of RUNNER_STATE_DIRECTORIES) expect((await stat(workspace.resolve(".runner", name))).isDirectory()).toBe(true);
    expect((await stat(workspace.root)).mode & 0o777).toBe(0o700);
  });

  it("reopens an existing workspace and keeps its identity", async () => {
    const workspace = await newWorkspace();
    const reopened = await Workspace.open(workspace.root);
    expect(reopened.manifest).toEqual(workspace.manifest);
    const again = await Workspace.openOrCreate(workspace.root, { packageVersion: "0.1.0", clock: new ManualClock() });
    expect(again.created).toBe(false);
    expect(again.workspace.manifest.workspaceId).toBe(workspace.manifest.workspaceId);
  });

  it("refuses to adopt a non-empty folder, and a folder with an invalid workspace.json", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "notes.txt"), "someone else's folder");
    await expect(Workspace.create(dir, { packageVersion: "0.1.0", clock: new ManualClock() })).rejects.toBeInstanceOf(WorkspaceError);
    const bad = await tempDir();
    await writeFile(path.join(bad, "workspace.json"), JSON.stringify({ workspaceId: "" }));
    await expect(Workspace.open(bad)).rejects.toThrow(/does not match the contract/);
    await expect(Workspace.open(path.join(bad, "missing"))).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("confines every path to the workspace root", async () => {
    const workspace = await newWorkspace();
    expect(workspace.resolve("jobs", "job-1", "snapshot-1.json")).toBe(path.join(workspace.root, "jobs", "job-1", "snapshot-1.json"));
    for (const segments of [["..", "escape.json"], ["jobs", "..", "..", "x"], ["/etc/passwd"], ["C:\\Windows"], ["jobs\0.json"], [""]]) {
      expect(() => workspace.resolve(...segments), JSON.stringify(segments)).toThrow(WorkspacePathError);
    }
    await expect(workspace.writeJson(["..", "outside.json"], {})).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it("refuses a symlink inside the workspace that points outside it", async () => {
    const workspace = await newWorkspace();
    const outside = await tempDir("wc-outside-");
    await symlink(outside, workspace.resolve("jobs", "linked"));
    await expect(workspace.writeJson(["jobs", "linked", "x.json"], { a: 1 })).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(workspace.readJson("jobs", "linked", "x.json")).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await readdir(outside)).toEqual([]);
    await mkdir(workspace.resolve("jobs", "inside"));
    await symlink(workspace.resolve("jobs", "inside"), workspace.resolve("jobs", "alias"));
    await workspace.writeJson(["jobs", "alias", "ok.json"], { a: 1 });
    expect(await workspace.readJson("jobs", "inside", "ok.json")).toEqual({ a: 1 });
  });
});

describe("event journal", () => {
  it("stores an eventId once and returns the first record on a replay", async () => {
    const workspace = await newWorkspace();
    const journal = new EventJournal(workspace);
    const event = jobCapture();
    const input = { event, deviceId: "2b1f7a0e-4c55-4d7e-9a61-0d3b1c2e5f70", receivedAt: new Date("2026-09-22T09:00:00.000Z"), bodySha256: "ab".repeat(32) };
    const first = await journal.append(input);
    const second = await journal.append({ ...input, receivedAt: new Date("2026-09-22T09:05:00.000Z") });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.receivedAt).toBe("2026-09-22T09:00:00.000Z");
    expect(await journal.list()).toHaveLength(1);
    const handled = await journal.recordDispatch(event.eventId, { status: "handled", at: "2026-09-22T09:00:01.000Z", handler: "captures" });
    expect(handled.attempts).toBe(1);
    expect(await journal.list({ dispatch: "handled", type: "job_capture" })).toHaveLength(1);
    expect(await journal.list({ dispatch: "no_handler" })).toHaveLength(0);
  });
});

describe("model check record", () => {
  it("round-trips and keeps no prompt or reply text", async () => {
    const workspace = await newWorkspace();
    expect(await readModelCheck(workspace)).toBeUndefined();
    await writeModelCheck(workspace, { provider: "chatgpt", model: "gpt-5.6-luna", ok: true, checkedAt: "2026-09-22T09:00:00.000Z", via: "doctor" });
    expect(await readModelCheck(workspace)).toEqual({ provider: "chatgpt", model: "gpt-5.6-luna", ok: true, checkedAt: "2026-09-22T09:00:00.000Z", via: "doctor" });
    await expect(writeModelCheck(workspace, { provider: "chatgpt", model: "x", ok: false, checkedAt: "t", via: "doctor", reply: "ok" } as never)).rejects.toThrow();
  });
});
