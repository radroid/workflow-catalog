import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { runRecordSchema } from "@workflow-catalog/contracts";
import { describe, expect, it, vi } from "vitest";
import { ManualClock, DAY_MS } from "../lib/clock.ts";
import { countCountableRuns, finishRun, getRun, hasSucceededWithIdempotencyKey, listRuns, localDateString, startRun, writePausedRun } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

/** chmod can only deny access to a non-root user on a POSIX filesystem; CI (ubuntu, non-root) and macOS qualify. */
const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

describe("store/runs.ts: localDateString", () => {
  it("uses the local calendar date, not UTC — a local-time constructor either side of local midnight lands on the two different days", () => {
    // Date(year, monthIndex, day, h, m, s) reads its arguments as local time
    // components, whatever TZ the process runs under, which is exactly what
    // makes this assertion hold under every TZ the packet re-runs this suite
    // in (Pacific/Kiritimati, Pacific/Pago_Pago, and CI's default).
    expect(localDateString(new Date(2026, 8, 22, 23, 59, 59))).toBe("2026-09-22");
    expect(localDateString(new Date(2026, 8, 23, 0, 0, 1))).toBe("2026-09-23");
  });

  it("zero-pads month and day", () => {
    expect(localDateString(new Date(2026, 0, 5, 12, 0, 0))).toBe("2026-01-05");
  });
});

/** Explicitly sets/restores process.env.TZ around `run` (sync or async), so a test's outcome never depends on the ambient shell. */
async function withTz<T>(tz: string, run: () => T | Promise<T>): Promise<T> {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe("store/runs.ts: localDateString under an explicit TZ=UTC (nit: this is what CI uses)", () => {
  it("still lands on the correct local (=UTC) calendar date either side of midnight", async () => {
    await withTz("UTC", () => {
      expect(localDateString(new Date("2026-09-22T23:59:59.000Z"))).toBe("2026-09-22");
      expect(localDateString(new Date("2026-09-23T00:00:01.000Z"))).toBe("2026-09-23");
    });
  });
});

// Nit 1 (round 2): the TZ=UTC case above passes even with UTC getters, so on its own it can't pin decision 4 under
// CI's zone. These switch the zone at run time (probe-tz.txt showed that takes effect inside vitest's worker), to
// zones where the local and UTC calendar dates differ for the same instant, whatever zone the suite runs in.
describe("store/runs.ts: decision 4 pinned under zones whose date differs from UTC (I3, nit 1)", () => {
  it("Pacific/Kiritimati (UTC+14): an instant that is still 22 Sep in UTC is already 23 Sep locally", async () => {
    await withTz("Pacific/Kiritimati", () => {
      expect(localDateString(new Date("2026-09-22T12:00:00.000Z"))).toBe("2026-09-23");
      expect(localDateString(new Date("2026-09-22T09:59:59.000Z"))).toBe("2026-09-22");
    });
  });

  it("Pacific/Pago_Pago (UTC−11): an instant that is already 22 Sep in UTC is still 21 Sep locally", async () => {
    await withTz("Pacific/Pago_Pago", () => {
      expect(localDateString(new Date("2026-09-22T05:00:00.000Z"))).toBe("2026-09-21");
      expect(localDateString(new Date("2026-09-22T11:00:00.000Z"))).toBe("2026-09-22");
    });
  });

  it("under Pacific/Kiritimati a run files under its local date, and today's budget count finds it there", async () => {
    await withTz("Pacific/Kiritimati", async () => {
      const clock = new ManualClock("2026-09-22T12:00:00.000Z"); // 02:00 on 23 Sep in Kiritimati
      const workspace = await newWorkspace(clock);
      const runId = randomUUID();
      const { startedAt } = await startRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "kiritimati", inputs: {} });
      await finishRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "kiritimati", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });
      expect(await workspace.list("runs", "2026-09-23")).toEqual([`${runId}.json`]);
      expect(await workspace.list("runs", "2026-09-22")).toEqual([]);
      expect(await countCountableRuns(workspace, localDateString(clock.now()))).toBe(1);
      expect((await getRun(workspace, runId))?.path).toBe(`runs/2026-09-23/${runId}.json`);
    });
  });
});

describe("store/runs.ts: a run crossing local midnight (nit)", () => {
  it("stays filed under its startedAt date even when finishRun happens on the next local day", async () => {
    await withTz("UTC", async () => {
      const clock = new ManualClock("2026-09-22T23:59:30.000Z");
      const workspace = await newWorkspace(clock);
      const runId = randomUUID();
      const { startedAt } = await startRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "midnight", inputs: {} });
      clock.advance(60_000); // now 2026-09-23T00:00:30Z: a new local day under TZ=UTC
      await finishRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "midnight", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });

      expect(await workspace.list("runs", "2026-09-22")).toEqual([`${runId}.json`]);
      expect(await workspace.list("runs", "2026-09-23")).toEqual([]);
      const record = await getRun(workspace, runId);
      expect(record?.path).toBe(`runs/2026-09-22/${runId}.json`);
    });
  });
});

describe("store/runs.ts: start/finish (crash safety)", () => {
  it("startRun writes a crash-safe placeholder; finishRun overwrites the same file with the real outcome", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, {
      runId,
      kind: "manual",
      isCatchUp: false,
      idempotencyKey: "key-1",
      inputs: { jobIds: ["a", "b"] },
    });

    const placeholder = await getRun(workspace, runId);
    expect(placeholder).toMatchObject({ outcome: "failure", error: "interrupted: the runner stopped before this run finished", model: "n/a" });
    expect(placeholder?.finishedAt).toBeUndefined();
    // Validate what is actually on disk (getRun's RunRecordWithPath adds a
    // `path` field for API/UI use, which the stored record itself never has).
    const placeholderDate = localDateString(new Date(startedAt));
    const rawPlaceholder = await workspace.readJson("runs", placeholderDate, `${runId}.json`);
    expect(runRecordSchema.safeParse(rawPlaceholder).success).toBe(true);

    clock.advance(5_000);
    const finished = await finishRun(workspace, clock, {
      runId,
      kind: "manual",
      isCatchUp: false,
      idempotencyKey: "key-1",
      inputs: { jobIds: ["a", "b"] },
      startedAt,
      outcome: "success",
      model: "gpt-5.6-luna",
      tokens: { input: 120, output: 45 },
    });
    expect(finished.durationMs).toBe(5_000);
    expect(finished.finishedAt).toBeDefined();
    expect(finished.error).toBeUndefined();
    expect(runRecordSchema.safeParse(finished).success).toBe(true);

    const reread = await getRun(workspace, runId);
    expect(reread).toMatchObject({ outcome: "success", model: "gpt-5.6-luna", tokens: { input: 120, output: 45 }, durationMs: 5_000 });
    // Still exactly one file: finishRun overwrote the placeholder, it did not create a second record.
    const date = localDateString(new Date(startedAt));
    expect(await workspace.list("runs", date)).toEqual([`${runId}.json`]);
  });

  it("a killed process (startRun only, no finishRun) leaves the interrupted placeholder as an honest record", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    await startRun(workspace, clock, { runId, kind: "prepare_newly_saved_jobs", isCatchUp: false, idempotencyKey: "key-2", inputs: {} });
    const record = await getRun(workspace, runId);
    expect(record?.outcome).toBe("failure");
    expect(record?.error).toBe("interrupted: the runner stopped before this run finished");
    expect(record?.finishedAt).toBeUndefined();
  });

  it("writes human-readable pretty JSON with a stable key order", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "key-3", inputs: {} });
    await finishRun(workspace, clock, {
      runId,
      kind: "manual",
      isCatchUp: false,
      idempotencyKey: "key-3",
      inputs: {},
      startedAt,
      outcome: "failure",
      model: "gpt-5.6-luna",
      tokens: { input: 1, output: 1 },
      error: "boom",
    });
    const date = localDateString(new Date(startedAt));
    const raw = await workspace.readJson("runs", date, `${runId}.json`);
    expect(Object.keys(raw as object)).toEqual(["runId", "kind", "isCatchUp", "inputs", "idempotencyKey", "outcome", "model", "tokens", "durationMs", "startedAt", "finishedAt", "error"]);
  });

  it("writePausedRun is a one-shot record: startedAt equals finishedAt, zero duration", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    const record = await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "key-4", inputs: {}, reason: "daily run limit reached (10)" });
    expect(record).toMatchObject({ outcome: "paused", error: "daily run limit reached (10)", durationMs: 0, model: "n/a" });
    expect(record.startedAt).toBe(record.finishedAt);
    expect(runRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("store/runs.ts: listing and reading", () => {
  it("lists newest first and is bounded by limit", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const runId = randomUUID();
      ids.push(runId);
      await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: `k${i}`, inputs: {}, reason: "r" });
      clock.advance(60_000);
    }
    const all = await listRuns(workspace, clock);
    expect(all.records.map((r) => r.runId)).toEqual([ids[2], ids[1], ids[0]]);
    expect(all.invalidCount).toBe(0);

    const bounded = await listRuns(workspace, clock, { limit: 2 });
    expect(bounded.records.map((r) => r.runId)).toEqual([ids[2], ids[1]]);
  });

  it("excludes records older than the retention window", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const oldRunId = randomUUID();
    await writePausedRun(workspace, clock, { runId: oldRunId, kind: "manual", isCatchUp: false, idempotencyKey: "old", inputs: {}, reason: "r" });
    clock.advance(20 * DAY_MS);
    const recentRunId = randomUUID();
    await writePausedRun(workspace, clock, { runId: recentRunId, kind: "manual", isCatchUp: false, idempotencyKey: "new", inputs: {}, reason: "r" });

    const { records } = await listRuns(workspace, clock, { sinceDays: 14 });
    expect(records.map((r) => r.runId)).toEqual([recentRunId]);
  });

  it("skips an invalid file with a visible note (invalidCount), never crashing the list", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const goodId = randomUUID();
    await writePausedRun(workspace, clock, { runId: goodId, kind: "manual", isCatchUp: false, idempotencyKey: "good", inputs: {}, reason: "r" });
    const date = localDateString(clock.now());
    // A file that is not even valid JSON, and one that is valid JSON but fails the schema.
    const dir = workspace.resolve("runs", date);
    await writeFile(`${dir}/${randomUUID()}.json`, "{ not json", "utf8");
    await workspace.writeJson(["runs", date, `${randomUUID()}.json`], { not: "a run record" });

    const { records, invalidCount } = await listRuns(workspace, clock);
    expect(records.map((r) => r.runId)).toEqual([goodId]);
    expect(invalidCount).toBe(2);
  });

  it("getRun validates the uuid before touching the filesystem", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const listSpy = vi.spyOn(workspace, "list");
    const readSpy = vi.spyOn(workspace, "readJson");
    expect(await getRun(workspace, "not-a-uuid")).toBeUndefined();
    expect(listSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("getRun returns undefined for a well-formed uuid that has no run", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    expect(await getRun(workspace, randomUUID())).toBeUndefined();
  });

  it("each record's path is runs/<date>/<runId>.json, openable from the workspace root", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "k", inputs: {}, reason: "r" });
    const record = await getRun(workspace, runId);
    const date = localDateString(clock.now());
    expect(record?.path).toBe(`runs/${date}/${runId}.json`);
  });

  it("G8: absolutePath resolves the same file under the workspace root, from both getRun and listRuns", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "k", inputs: {}, reason: "r" });
    const record = await getRun(workspace, runId);
    const date = localDateString(clock.now());
    expect(record?.absolutePath).toBe(workspace.resolve("runs", date, `${runId}.json`));
    const { records } = await listRuns(workspace, clock);
    expect(records[0]?.absolutePath).toBe(record?.absolutePath);
  });

  it("getRun refuses a file whose own runId field does not match the filename (nit: defends a hand-edited or corrupted file)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    const wrongId = randomUUID();
    await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "k", inputs: {}, reason: "r" });
    const date = localDateString(clock.now());
    const raw = (await workspace.readJson("runs", date, `${runId}.json`)) as Record<string, unknown>;
    await workspace.writeJson(["runs", date, `${runId}.json`], { ...raw, runId: wrongId });
    expect(await getRun(workspace, runId)).toBeUndefined();
  });

  it("G9/nit: skippedFiles names up to 10 invalid/unreadable paths in <code>-ready relative form; invalidCount still counts every one", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const date = localDateString(clock.now());
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "seed", inputs: {}, reason: "r" }); // ensures runs/<date>/ exists
    const badPaths: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const file = `${randomUUID()}.json`;
      await writeFile(workspace.resolve("runs", date, file), "{ not json", "utf8");
      badPaths.push(`runs/${date}/${file}`);
    }
    const { records, invalidCount, skippedFiles } = await listRuns(workspace, clock);
    expect(records.length).toBe(1); // the seed
    expect(invalidCount).toBe(12);
    expect(skippedFiles.length).toBe(10);
    for (const path of skippedFiles) expect(badPaths).toContain(path);
  });

  it.skipIf(!canDenyAccess)("I2: runs/ itself unreadable (chmod 000) is reported as one skipped entry, never thrown", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "hidden", inputs: {}, reason: "r" });
    const runs = workspace.resolve("runs");
    await chmod(runs, 0o000);
    try {
      expect(await listRuns(workspace, clock)).toEqual({ records: [], invalidCount: 1, skippedFiles: ["runs/"] });
    } finally {
      await chmod(runs, 0o700);
    }
  });

  it("nit: an error listing one date directory skips just that directory with a note, not a 500", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const goodId = randomUUID();
    await writePausedRun(workspace, clock, { runId: goodId, kind: "manual", isCatchUp: false, idempotencyKey: "good", inputs: {}, reason: "r" });
    clock.advance(DAY_MS);
    const badDate = localDateString(clock.now());
    await workspace.writeJson(["runs", badDate, `${randomUUID()}.json`], { not: "read: list() is mocked to throw for this date below" });

    const original = workspace.list.bind(workspace);
    const listSpy = vi.spyOn(workspace, "list").mockImplementation(async (...segments: string[]) => {
      if (segments[0] === "runs" && segments[1] === badDate) throw new Error("EACCES (simulated)");
      return original(...segments);
    });
    try {
      const { records, invalidCount, skippedFiles } = await listRuns(workspace, clock);
      expect(records.map((r) => r.runId)).toEqual([goodId]); // the good directory still comes back
      expect(invalidCount).toBe(1);
      expect(skippedFiles).toEqual([`runs/${badDate}/`]);
    } finally {
      listSpy.mockRestore();
    }
  });

  // P08-A round-3 review, carried nit 4: "GET /api/runs/:runId returns 500 when runs/ is unreadable (runs.ts:286).
  // Catch it as listRuns does."
  it.skipIf(!canDenyAccess)("P08-B carried nit 4: getRun over an unreadable runs/ resolves undefined, never throws", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const runId = randomUUID();
    await writePausedRun(workspace, clock, { runId, kind: "manual", isCatchUp: false, idempotencyKey: "hidden", inputs: {}, reason: "r" });
    const runs = workspace.resolve("runs");
    await chmod(runs, 0o000);
    try {
      await expect(getRun(workspace, runId)).resolves.toBeUndefined();
    } finally {
      await chmod(runs, 0o700);
    }
  });

  // P08-A round-3 review, carried P-b (UI critic polish): "Folders are listed before files in the skipped note,
  // or flagged by the server, and a lone folder reads as a folder."
  describe("P08-B carried P-b: folder skips are reported before file skips", () => {
    it("a folder skip from an older date is never pushed out of the top 10 by newer file skips", async () => {
      const clock = new ManualClock();
      const workspace = await newWorkspace(clock);
      const goodId = randomUUID();
      await writePausedRun(workspace, clock, { runId: goodId, kind: "manual", isCatchUp: false, idempotencyKey: "good", inputs: {}, reason: "r" });
      const olderDate = localDateString(clock.now());
      clock.advance(DAY_MS);
      const newerDate = localDateString(clock.now());
      await mkdir(workspace.resolve("runs", newerDate), { recursive: true });
      // 10 unreadable *files* on the newer date (encountered first: dates are walked newest-first).
      for (let i = 0; i < 10; i += 1) await writeFile(workspace.resolve("runs", newerDate, `${randomUUID()}.json`), "{ not json", "utf8");

      const original = workspace.list.bind(workspace);
      const listSpy = vi.spyOn(workspace, "list").mockImplementation(async (...segments: string[]) => {
        if (segments[0] === "runs" && segments[1] === olderDate) throw new Error("EACCES (simulated)");
        return original(...segments);
      });
      try {
        const { skippedFiles, invalidCount } = await listRuns(workspace, clock);
        expect(invalidCount).toBe(11); // 10 files + the one unreadable folder
        expect(skippedFiles).toHaveLength(10); // capped
        expect(skippedFiles[0]).toBe(`runs/${olderDate}/`); // the folder leads, despite being the older/later-encountered entry
      } finally {
        listSpy.mockRestore();
      }
    });
  });
});

describe("store/runs.ts: countCountableRuns", () => {
  it("counts valid success/failure records, never paused ones", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const date = localDateString(clock.now());
    const successId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId: successId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {} });
    await finishRun(workspace, clock, { runId: successId, kind: "manual", isCatchUp: false, idempotencyKey: "s", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });
    const failId = randomUUID();
    const startedFail = await startRun(workspace, clock, { runId: failId, kind: "manual", isCatchUp: false, idempotencyKey: "f", inputs: {} });
    await finishRun(workspace, clock, { runId: failId, kind: "manual", isCatchUp: false, idempotencyKey: "f", inputs: {}, startedAt: startedFail.startedAt, outcome: "failure", model: "m", tokens: { input: 0, output: 0 }, error: "e" });
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "p", inputs: {}, reason: "r" });

    expect(await countCountableRuns(workspace, date)).toBe(2);
  });

  it("returns 0 for a date with no runs directory yet", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    expect(await countCountableRuns(workspace, "2020-01-01")).toBe(0);
  });
});

describe("store/runs.ts: hasSucceededWithIdempotencyKey", () => {
  it("is true only for a key a successful run actually used", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const succeeded = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId: succeeded, kind: "manual", isCatchUp: false, idempotencyKey: "used-key", inputs: {} });
    await finishRun(workspace, clock, { runId: succeeded, kind: "manual", isCatchUp: false, idempotencyKey: "used-key", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });
    const failed = randomUUID();
    const startedFailed = await startRun(workspace, clock, { runId: failed, kind: "manual", isCatchUp: false, idempotencyKey: "failed-key", inputs: {} });
    await finishRun(workspace, clock, { runId: failed, kind: "manual", isCatchUp: false, idempotencyKey: "failed-key", inputs: {}, startedAt: startedFailed.startedAt, outcome: "failure", model: "m", tokens: { input: 0, output: 0 }, error: "e" });

    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "used-key")).toBe(true);
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "failed-key")).toBe(false);
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "never-seen")).toBe(false);
  });

  it("nit: a paused record with a matching key never counts as succeeded", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: "shared-key", inputs: {}, reason: "daily run limit reached (10)" });
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "shared-key")).toBe(false);
  });
});

describe("store/runs.ts: G3 (round-1 revision, reviewer issue 4) — the idempotency window is not capped at 200", () => {
  it("finds a success from 5 days ago behind more than 200 newer records (mutation target: reintroduce listRuns's 200 cap here)", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    const key = "prepare:job-northwind-labs";
    const oldId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId: oldId, kind: "prepare_newly_saved_jobs", isCatchUp: false, idempotencyKey: key, inputs: {} });
    await finishRun(workspace, clock, { runId: oldId, kind: "prepare_newly_saved_jobs", isCatchUp: false, idempotencyKey: key, inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 1, output: 1 } });
    clock.advance(DAY_MS);
    const perDay = 51;
    for (let day = 0; day < 4; day += 1) {
      for (let i = 0; i < perDay; i += 1) {
        await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: `other-${day}-${i}`, inputs: {}, reason: "daily run limit reached (50)" });
        clock.advance(60_000);
      }
      clock.advance(DAY_MS - perDay * 60_000);
    }
    // 204 newer records (4 days × 51) now sit strictly ahead of the 5-day-old success in the window; listRuns's own
    // 200-record page never reaches it.
    const page = await listRuns(workspace, clock);
    expect(page.records.length).toBe(200);
    expect(page.records.some((record) => record.runId === oldId)).toBe(false);
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, key)).toBe(true);
  });

  it("stops at the first match, newest first: far fewer files are read than the full window holds", async () => {
    const clock = new ManualClock();
    const workspace = await newWorkspace(clock);
    for (let day = 0; day < 10; day += 1) {
      for (let i = 0; i < 30; i += 1) {
        await writePausedRun(workspace, clock, { runId: randomUUID(), kind: "manual", isCatchUp: false, idempotencyKey: `other-${day}-${i}`, inputs: {}, reason: "r" });
      }
      clock.advance(DAY_MS);
    }
    const matchId = randomUUID();
    const { startedAt } = await startRun(workspace, clock, { runId: matchId, kind: "manual", isCatchUp: false, idempotencyKey: "the-key", inputs: {} });
    await finishRun(workspace, clock, { runId: matchId, kind: "manual", isCatchUp: false, idempotencyKey: "the-key", inputs: {}, startedAt, outcome: "success", model: "m", tokens: { input: 0, output: 0 } });

    const readSpy = vi.spyOn(workspace, "readJson");
    expect(await hasSucceededWithIdempotencyKey(workspace, clock, "the-key")).toBe(true);
    // The match is alone in the newest (11th) date directory: only it should have been read, nowhere near the
    // 300+ records spread across the other 10 days.
    expect(readSpy.mock.calls.length).toBeLessThan(60);
    readSpy.mockRestore();
  });
});
