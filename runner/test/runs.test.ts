import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { runRecordSchema } from "@workflow-catalog/contracts";
import { describe, expect, it, vi } from "vitest";
import { ManualClock, DAY_MS } from "../lib/clock.ts";
import { countCountableRuns, finishRun, getRun, hasSucceededWithIdempotencyKey, listRuns, localDateString, startRun, writePausedRun } from "../store/runs.ts";
import { newWorkspace } from "./helpers.ts";

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
});
