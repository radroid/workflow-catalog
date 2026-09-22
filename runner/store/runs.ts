import { runRecordSchema, uuidSchema, type RunKind, type RunRecord, type RunTokenUsage } from "@workflow-catalog/contracts";
import { DAY_MS, type Clock } from "../lib/clock.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The run log (F11, mvp-spec §5): one `runs/<date>/<runId>.json` per run,
 * human-readable (pretty JSON, stable key order), written atomically through
 * `Workspace.writeJson` (`store/atomic.ts`).
 *
 * `<date>` is the *local* calendar date of the run's `startedAt` — the
 * runner process's own OS timezone (`Date#getFullYear/getMonth/getDate`),
 * not UTC. A run that starts at 23:50 local time files under that local day
 * even though `startedAt` itself is a UTC-offset ISO string. This only
 * matters for which directory a record lives in and for
 * `store/budget.ts`'s "today" window; the record's own timestamps are
 * unambiguous ISO datetimes regardless.
 *
 * Crash safety: `startRun` writes a placeholder record with
 * `outcome: "failure"` before the run body does any work; `finishRun`
 * overwrites the same file with the real outcome. A killed process leaves
 * the placeholder, which is an honest record ("interrupted").
 */

/** No model was ever contacted for this record (a paused run, or the crash-safe placeholder). */
export const NO_MODEL = "n/a";

export const DEFAULT_RUN_LIST_LIMIT = 200;
export const DEFAULT_RUN_LIST_WINDOW_DAYS = 14;

const RUNS_SEGMENT = "runs";
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const INTERRUPTED_ERROR = "interrupted: the runner stopped before this run finished";

/** The declared field order of `runRecordSchema`, restated so every write uses the same key order regardless of build order. */
const RECORD_KEY_ORDER = [
  "runId",
  "kind",
  "isCatchUp",
  "inputs",
  "idempotencyKey",
  "outcome",
  "model",
  "tokens",
  "durationMs",
  "startedAt",
  "finishedAt",
  "error",
] as const satisfies readonly (keyof RunRecord)[];

export interface RunRecordWithPath extends RunRecord {
  /** `runs/<date>/<runId>.json`, relative to the workspace root, for the person to open. */
  readonly path: string;
}

/** The OS-local calendar date (`YYYY-MM-DD`) of `date`, per decision 4 (never UTC). */
export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function orderedRecord(record: RunRecord): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of RECORD_KEY_ORDER) {
    const value = record[key];
    if (value !== undefined) ordered[key] = value;
  }
  return ordered;
}

function segmentsFor(date: string, runId: string): string[] {
  return [RUNS_SEGMENT, date, `${runId}.json`];
}

async function writeRecord(workspace: Workspace, startedAtIso: string, runId: string, record: RunRecord): Promise<void> {
  const date = localDateString(new Date(startedAtIso));
  await workspace.writeJson(segmentsFor(date, runId), orderedRecord(record));
}

/** Reads and validates one run file. Undefined for a missing, unreadable or invalid file — never throws. */
async function readRecord(workspace: Workspace, date: string, file: string): Promise<RunRecord | undefined> {
  let raw: unknown;
  try {
    raw = await workspace.readJson(RUNS_SEGMENT, date, file);
  } catch {
    // Malformed JSON (readJsonFile does not catch JSON.parse) or an I/O error:
    // treated the same as "invalid", never thrown up to a list/read caller.
    return undefined;
  }
  if (raw === undefined) return undefined;
  const parsed = runRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function dateDirectories(workspace: Workspace): Promise<string[]> {
  return (await workspace.list(RUNS_SEGMENT)).filter((name) => DATE_DIR.test(name));
}

export interface StartRunInput {
  readonly runId: string;
  readonly kind: RunKind;
  readonly isCatchUp: boolean;
  readonly inputs: Record<string, unknown>;
  readonly idempotencyKey: string;
}

/**
 * Writes the crash-safe placeholder for a run that is about to start:
 * `outcome: "failure"`, an "interrupted" error, no `finishedAt`. `finishRun`
 * overwrites this same file once the run actually finishes. If the process
 * dies in between, the placeholder stands as an honest record.
 */
export async function startRun(workspace: Workspace, clock: Clock, input: StartRunInput): Promise<{ startedAt: string }> {
  const startedAt = clock.now().toISOString();
  const record = runRecordSchema.parse({
    runId: input.runId,
    kind: input.kind,
    isCatchUp: input.isCatchUp,
    inputs: input.inputs,
    idempotencyKey: input.idempotencyKey,
    outcome: "failure",
    model: NO_MODEL,
    tokens: { input: 0, output: 0 },
    durationMs: 0,
    startedAt,
    error: INTERRUPTED_ERROR,
  } satisfies RunRecord);
  await writeRecord(workspace, startedAt, input.runId, record);
  return { startedAt };
}

export interface FinishRunInput {
  readonly runId: string;
  readonly kind: RunKind;
  readonly isCatchUp: boolean;
  readonly inputs: Record<string, unknown>;
  readonly idempotencyKey: string;
  /** The `startedAt` `startRun` returned — fixes which date directory this overwrites. */
  readonly startedAt: string;
  readonly outcome: "success" | "failure";
  readonly model: string;
  readonly tokens: RunTokenUsage;
  /** Present when `outcome` is `"failure"`. Truncated by the caller. */
  readonly error?: string;
}

/** Overwrites the placeholder `startRun` wrote with the run's real outcome. */
export async function finishRun(workspace: Workspace, clock: Clock, input: FinishRunInput): Promise<RunRecord> {
  const finishedAt = clock.now().toISOString();
  const durationMs = Math.max(0, new Date(finishedAt).getTime() - new Date(input.startedAt).getTime());
  const record = runRecordSchema.parse({
    runId: input.runId,
    kind: input.kind,
    isCatchUp: input.isCatchUp,
    inputs: input.inputs,
    idempotencyKey: input.idempotencyKey,
    outcome: input.outcome,
    model: input.model,
    tokens: input.tokens,
    durationMs,
    startedAt: input.startedAt,
    finishedAt,
    ...(input.error !== undefined ? { error: input.error } : {}),
  } satisfies RunRecord);
  await writeRecord(workspace, input.startedAt, input.runId, record);
  return record;
}

export interface WritePausedRunInput {
  readonly runId: string;
  readonly kind: RunKind;
  readonly isCatchUp: boolean;
  readonly inputs: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly reason: string;
}

/** One-shot record for a run refused before it started: the body never ran, so there is no placeholder-then-overwrite. */
export async function writePausedRun(workspace: Workspace, clock: Clock, input: WritePausedRunInput): Promise<RunRecord> {
  const now = clock.now().toISOString();
  const record = runRecordSchema.parse({
    runId: input.runId,
    kind: input.kind,
    isCatchUp: input.isCatchUp,
    inputs: input.inputs,
    idempotencyKey: input.idempotencyKey,
    outcome: "paused",
    model: NO_MODEL,
    tokens: { input: 0, output: 0 },
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    error: input.reason,
  } satisfies RunRecord);
  await writeRecord(workspace, now, input.runId, record);
  return record;
}

export interface ListRunsOptions {
  readonly limit?: number;
  readonly sinceDays?: number;
}

export interface ListRunsResult {
  readonly records: readonly RunRecordWithPath[];
  /** Files that existed but did not validate (or were not readable): skipped, never thrown, surfaced as a count so the UI can say so. */
  readonly invalidCount: number;
}

/** Newest first, bounded to `limit` records within the last `sinceDays` local days (F11; defaults 200 / 14). */
export async function listRuns(workspace: Workspace, clock: Clock, options: ListRunsOptions = {}): Promise<ListRunsResult> {
  const limit = options.limit ?? DEFAULT_RUN_LIST_LIMIT;
  const sinceDays = options.sinceDays ?? DEFAULT_RUN_LIST_WINDOW_DAYS;
  const cutoff = localDateString(new Date(clock.now().getTime() - sinceDays * DAY_MS));
  const dateDirs = (await dateDirectories(workspace)).sort().reverse();
  const records: RunRecordWithPath[] = [];
  let invalidCount = 0;
  for (const date of dateDirs) {
    if (date < cutoff) break; // sorted descending: every remaining directory is also out of the window
    const files = (await workspace.list(RUNS_SEGMENT, date)).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      const record = await readRecord(workspace, date, file);
      if (!record) {
        invalidCount += 1;
        continue;
      }
      records.push({ ...record, path: `${RUNS_SEGMENT}/${date}/${file}` });
    }
  }
  // Every writer here stamps startedAt via Date#toISOString() (fixed-width, UTC "Z" suffix), so a lexical
  // sort is a chronological sort.
  records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { records: records.slice(0, limit), invalidCount };
}

/** Undefined for a non-uuid `runId` (no filesystem touch), a missing run, or one whose file does not validate. */
export async function getRun(workspace: Workspace, runId: string): Promise<RunRecordWithPath | undefined> {
  if (!uuidSchema.safeParse(runId).success) return undefined;
  const dateDirs = await dateDirectories(workspace);
  const file = `${runId}.json`;
  for (const date of dateDirs) {
    const record = await readRecord(workspace, date, file);
    if (record) return { ...record, path: `${RUNS_SEGMENT}/${date}/${file}` };
  }
  return undefined;
}

/** `budget.ts`'s `runsUsedToday`: valid records for the local date that are not themselves `"paused"`. */
export async function countCountableRuns(workspace: Workspace, date: string): Promise<number> {
  const files = (await workspace.list(RUNS_SEGMENT, date)).filter((name) => name.endsWith(".json"));
  let count = 0;
  for (const file of files) {
    const record = await readRecord(workspace, date, file);
    if (record && record.outcome !== "paused") count += 1;
  }
  return count;
}

/** The idempotency lookup P05 and P08-B use: has a run with this key already succeeded within the retained window? */
export async function hasSucceededWithIdempotencyKey(workspace: Workspace, clock: Clock, idempotencyKey: string, options: ListRunsOptions = {}): Promise<boolean> {
  const { records } = await listRuns(workspace, clock, options);
  return records.some((record) => record.outcome === "success" && record.idempotencyKey === idempotencyKey);
}
