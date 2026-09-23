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

/** No model was ever contacted for this record (a paused run, the crash-safe placeholder, or a body that never ran a turn). */
export const NO_MODEL = "n/a";

/**
 * The run sent at least one turn to eve, but no `step.started` ever named the
 * model: a turn that timed out before its first step, for example (I3, nit 8).
 * Distinct from `NO_MODEL` so the Runs page can still show such a run's
 * duration and tokens while hiding only the model it never learned, and keep
 * hiding the whole line for records that never called the model at all (G8).
 */
export const UNKNOWN_MODEL = "unknown";

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
  /**
   * The same file's absolute, OS-native path (G8, round-1 revision): local-API-only,
   * never included in `GET /status` (that route never touches this type).
   * Computed with `Workspace#resolve`, which does no I/O of its own.
   */
  readonly absolutePath: string;
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

/** Up to this many skipped (unreadable/invalid) paths are named in a `listRuns` result; `invalidCount` still counts every one (G9, nit). */
export const MAX_SKIPPED_FILES_REPORTED = 10;

export interface ListRunsResult {
  readonly records: readonly RunRecordWithPath[];
  /** Files (or, when a whole date directory could not be listed, that directory) skipped because they didn't validate or couldn't be read: never thrown, always counted. */
  readonly invalidCount: number;
  /** Up to `MAX_SKIPPED_FILES_REPORTED` relative paths of what `invalidCount` counted, so the UI can name them (G9). A directory that itself failed to list is reported as `runs/<date>/`. */
  readonly skippedFiles: readonly string[];
}

function withPath(workspace: Workspace, record: RunRecord, date: string, file: string): RunRecordWithPath {
  return { ...record, path: `${RUNS_SEGMENT}/${date}/${file}`, absolutePath: workspace.resolve(RUNS_SEGMENT, date, file) };
}

function pushSkipped(skippedFiles: string[], entry: string): void {
  if (skippedFiles.length < MAX_SKIPPED_FILES_REPORTED) skippedFiles.push(entry);
}

/** Newest first, bounded to `limit` records within the last `sinceDays` local days (F11; defaults 200 / 14). */
export async function listRuns(workspace: Workspace, clock: Clock, options: ListRunsOptions = {}): Promise<ListRunsResult> {
  const limit = options.limit ?? DEFAULT_RUN_LIST_LIMIT;
  const sinceDays = options.sinceDays ?? DEFAULT_RUN_LIST_WINDOW_DAYS;
  const cutoff = localDateString(new Date(clock.now().getTime() - sinceDays * DAY_MS));
  let dateDirs: string[];
  try {
    dateDirs = (await dateDirectories(workspace)).sort().reverse();
  } catch {
    // `runs/` itself can't be listed (a permissions problem, say): report it as one skipped entry, the same way
    // a single unreadable date directory is, rather than failing the whole list with a 500 (I2).
    return { records: [], invalidCount: 1, skippedFiles: [`${RUNS_SEGMENT}/`] };
  }
  const records: RunRecordWithPath[] = [];
  let invalidCount = 0;
  const skippedFiles: string[] = [];
  for (const date of dateDirs) {
    if (date < cutoff) break; // sorted descending: every remaining directory is also out of the window
    let files: string[];
    try {
      files = (await workspace.list(RUNS_SEGMENT, date)).filter((name) => name.endsWith(".json"));
    } catch {
      // An error listing one date directory (e.g. a permissions problem) skips just that directory with a
      // note, never a 500 for the whole page (nit).
      invalidCount += 1;
      pushSkipped(skippedFiles, `${RUNS_SEGMENT}/${date}/`);
      continue;
    }
    for (const file of files) {
      const record = await readRecord(workspace, date, file);
      if (!record) {
        invalidCount += 1;
        pushSkipped(skippedFiles, `${RUNS_SEGMENT}/${date}/${file}`);
        continue;
      }
      records.push(withPath(workspace, record, date, file));
    }
  }
  // Every writer here stamps startedAt via Date#toISOString() (fixed-width, UTC "Z" suffix), so a lexical
  // sort is a chronological sort.
  records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { records: records.slice(0, limit), invalidCount, skippedFiles };
}

/** Undefined for a non-uuid `runId` (no filesystem touch), a missing run, one whose file does not validate, or one whose file's own `runId` field does not match (nit: defends a hand-edited or corrupted file). */
export async function getRun(workspace: Workspace, runId: string): Promise<RunRecordWithPath | undefined> {
  if (!uuidSchema.safeParse(runId).success) return undefined;
  const dateDirs = await dateDirectories(workspace);
  const file = `${runId}.json`;
  for (const date of dateDirs) {
    const record = await readRecord(workspace, date, file);
    if (record && record.runId === runId) return withPath(workspace, record, date, file);
  }
  return undefined;
}

/**
 * `budget.ts`'s `runsUsedToday`: valid records for the local date that are not themselves `"paused"`. A missing
 * directory counts 0; a directory that exists but can't be listed rejects, and `getBudgetState` turns that into
 * the synthetic "run log unreadable" pause (I2) instead of guessing a count.
 */
export async function countCountableRuns(workspace: Workspace, date: string): Promise<number> {
  const files = (await workspace.list(RUNS_SEGMENT, date)).filter((name) => name.endsWith(".json"));
  let count = 0;
  for (const file of files) {
    const record = await readRecord(workspace, date, file);
    if (record && record.outcome !== "paused") count += 1;
  }
  return count;
}

export interface HasSucceededOptions {
  readonly sinceDays?: number;
}

/**
 * The idempotency lookup P05 and P08-B use: has a run with this key already
 * succeeded within the retained window? G3 (round-1 revision, reviewer issue
 * 4): scans the *whole* `sinceDays` window (default 14), newest first,
 * stopping at the first match — deliberately not `listRuns`'s 200-record
 * page, so a success outside the newest 200 records (behind a busy day)
 * still reads as "done" and never causes a duplicate run. A `paused` record
 * is never a match (it never ran): the `outcome === "success"` check below
 * already excludes it, same as `listRuns`.
 */
export async function hasSucceededWithIdempotencyKey(workspace: Workspace, clock: Clock, idempotencyKey: string, options: HasSucceededOptions = {}): Promise<boolean> {
  const sinceDays = options.sinceDays ?? DEFAULT_RUN_LIST_WINDOW_DAYS;
  const cutoff = localDateString(new Date(clock.now().getTime() - sinceDays * DAY_MS));
  const dateDirs = (await dateDirectories(workspace)).sort().reverse(); // newest date directory first
  for (const date of dateDirs) {
    if (date < cutoff) break;
    const files = (await workspace.list(RUNS_SEGMENT, date)).filter((name) => name.endsWith(".json"));
    const dayRecords: RunRecord[] = [];
    for (const file of files) {
      const record = await readRecord(workspace, date, file);
      if (record) dayRecords.push(record);
    }
    // Newest first within the day too, so "stopping at the first hit" is genuinely newest-first, not just
    // newest-directory-first.
    dayRecords.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    for (const record of dayRecords) {
      if (record.outcome === "success" && record.idempotencyKey === idempotencyKey) return true;
    }
  }
  return false;
}
