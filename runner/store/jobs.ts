import { jobSnapshotSchema, jobStructuredSchema, uuidSchema, type JobSnapshot, type JobStructured } from "@workflow-catalog/contracts";
import { z } from "zod";
import { sha256Hex, newId } from "../lib/crypto.ts";
import { serialise } from "./profile-writes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Job snapshots (F6, mvp-spec §5): `jobs/<jobId>/snapshot-<rev>.json`, one
 * file per revision, `{ url, capturedAt, extractorVersion, contentHash, text,
 * structured }`. No separate index file: a job's directory name *is* its id,
 * and its url is read back from any readable revision (the url never changes
 * across a job's revisions). Local-first scale, a person's own saved
 * postings, so a scan of `jobs/` is fine, the same trade-off
 * `EventJournal.list` makes.
 *
 * `captureJob` and `recordStructured` run under `serialise` (the in-process
 * per-workspace chain from `profile-writes.ts`, with its own map here so job
 * writes never queue behind profile writes): the bridge makes a fresh
 * `JobsStore` per request, so without it two nearly simultaneous captures of
 * the same new URL could each decide "no existing job" and create two job
 * directories for one URL.
 *
 * Damaged data (round-1 L6, round-2 T6). Only uuid-named directories are
 * jobs. A snapshot or extraction-state file that can't be read or parsed
 * never throws out of a read: it is reported as unreadable, by its
 * workspace-relative path, so a caller can name it. A job whose latest
 * revision is damaged still lists, named by the url any readable revision
 * records, and a recapture of that url lands in that same job.
 */

const JOBS_DIR = "jobs";
const SNAPSHOT_FILE = /^snapshot-(\d+)\.json$/;
const MAX_CAPTURE_ATTEMPTS = 5;
const JOB_CHAINS = new Map<string, Promise<unknown>>();

/** Round-1 review L6: only a uuid-named entry under `jobs/` is a job directory; a stray file such as `.DS_Store` is never descended into. */
function isJobId(name: string): boolean {
  return uuidSchema.safeParse(name).success;
}

export class JobsStoreError extends Error {
  override readonly name = "JobsStoreError";
}

export interface CaptureJobInput {
  readonly url: string;
  readonly text: string;
  readonly extractorVersion: string;
  readonly capturedAt: string;
}

export interface CaptureJobResult {
  readonly jobId: string;
  readonly revision: number;
  /** True only for the very first capture of a new job. */
  readonly isNewJob: boolean;
  /** False only when this exact URL's latest revision already has this exact content hash (P04 URL rule: "the same URL with the same content hash creates no new revision"). */
  readonly contentChanged: boolean;
  readonly snapshot: JobSnapshot;
}

export interface RecordStructuredResult {
  readonly ok: boolean;
  readonly message: string;
  readonly snapshot?: JobSnapshot;
}

/** One revision's snapshot as read from disk: never a throw. */
export type SnapshotRead = { readonly kind: "ok"; readonly snapshot: JobSnapshot } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

/** A snapshot file that exists but can't be read or parsed, by its path inside the workspace (`jobs/<jobId>/snapshot-<rev>.json`), for a page to name. */
export interface UnreadableSnapshot {
  readonly revision: number;
  readonly path: string;
}

export interface JobSummary {
  readonly jobId: string;
  /** Snapshot files on disk, readable or not. */
  readonly revisionCount: number;
  /** The highest revision number on disk. */
  readonly latestRevisionNumber: number;
  /** That revision's snapshot; absent when it can't be read. */
  readonly latest?: JobSnapshot;
  /** The newest revision that can be read: `latest` whenever that is readable. Absent when none can be. */
  readonly newestReadable?: JobSnapshot;
  /** The job's url, from any readable revision. Absent only when no revision can be read. */
  readonly url?: string;
  /** Snapshot files this summary had to step over, newest first: the latest one when it is damaged, and each damaged one below it until a readable revision. */
  readonly unreadable: readonly UnreadableSnapshot[];
}

export interface JobDetail {
  readonly jobId: string;
  /** Every revision number on disk, ascending, readable or not. */
  readonly revisionNumbers: readonly number[];
  /** The readable revisions, oldest first. */
  readonly revisions: readonly JobSnapshot[];
  /** The damaged revisions, oldest first. */
  readonly unreadable: readonly UnreadableSnapshot[];
}

/**
 * Extraction status, kept beside a revision's snapshot rather than inside it
 * (`jobs/<jobId>/extraction-<rev>.json`, round-1 L5): the contract's
 * `jobSnapshotSchema` is `.strict()`, and `packages/contracts` is outside
 * this packet, so this is P04's own side file. `waiting`/`running` describe
 * a queued or in-flight extraction and carry `owner`, the runner process that
 * queued it (round-2 T2), so a state an earlier process left behind can be
 * told apart from one this process is working on; `done` means the
 * snapshot's `structured` came from a successful turn; `not_run` means no
 * turn was attempted (`reason` says why); `failed` means a turn ran, or was
 * about to, and produced no fields for this revision. `interrupted` is never
 * stored: `captures.ts` derives it when reading a `waiting`/`running` state
 * this process does not own, or an extraction file that can't be read.
 * These are stable codes, not sentences: `runner/ui/assets/jobs.js` owns the
 * wording.
 */
export const EXTRACTION_NOT_RUN_REASONS = ["runner_not_running", "no_model", "budget_paused"] as const;
export type ExtractionNotRunReason = (typeof EXTRACTION_NOT_RUN_REASONS)[number];

/** `provider_limit`: the turn hit the model provider's rate limit, which also paused the budget. `unreadable`: the revision's snapshot file could not be read when its turn was due, or when its fields were saved. */
export const EXTRACTION_FAILURE_REASONS = ["timed_out", "turn_failed", "provider_limit", "no_fields_found", "unreadable", "interrupted"] as const;
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

export const extractionStateSchema = z
  .object({
    status: z.enum(["waiting", "running", "done", "not_run", "failed"]),
    reason: z.enum([...EXTRACTION_NOT_RUN_REASONS, ...EXTRACTION_FAILURE_REASONS]).optional(),
    /** Round-2 T2: which runner process queued or is running this (`waiting`/`running` only). */
    owner: z.string().min(1).max(128).optional(),
    updatedAt: z.string(),
  })
  .strict();

export type ExtractionState = z.infer<typeof extractionStateSchema>;

/** The path a person would find a job file at, inside their workspace. */
export function jobFilePath(jobId: string, file: string): string {
  return `${JOBS_DIR}/${jobId}/${file}`;
}

export class JobsStore {
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  #path(jobId: string, revision: number): string[] {
    return [JOBS_DIR, jobId, `snapshot-${revision}.json`];
  }

  #extractionPath(jobId: string, revision: number): string[] {
    return [JOBS_DIR, jobId, `extraction-${revision}.json`];
  }

  #unreadable(jobId: string, revision: number): UnreadableSnapshot {
    return { revision, path: jobFilePath(jobId, `snapshot-${revision}.json`) };
  }

  /**
   * The extraction state beside `jobId`/`revision`'s snapshot: `undefined`
   * when none was ever recorded, `"unreadable"` when the file exists but
   * can't be read or doesn't match the schema (round-2 T6: never a throw).
   */
  async getExtractionState(jobId: string, revision: number): Promise<ExtractionState | "unreadable" | undefined> {
    let raw: unknown;
    try {
      raw = await this.#workspace.readJson(...this.#extractionPath(jobId, revision));
    } catch {
      return "unreadable";
    }
    if (raw === undefined) return undefined;
    const parsed = extractionStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : "unreadable";
  }

  /** Overwrites `jobId`/`revision`'s extraction state (atomically, so a damaged file is simply replaced). The queue in `captures.ts` calls this at every transition. */
  async setExtractionState(jobId: string, revision: number, state: ExtractionState): Promise<void> {
    await this.#workspace.writeJson(this.#extractionPath(jobId, revision), extractionStateSchema.parse(state));
  }

  /** Revision numbers present for `jobId`, ascending: every snapshot file, readable or not. Empty when the job does not exist. */
  async revisions(jobId: string): Promise<number[]> {
    const names = await this.#workspace.list(JOBS_DIR, jobId);
    const numbers = names
      .map((name) => SNAPSHOT_FILE.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return numbers.sort((a, b) => a - b);
  }

  /** One revision's snapshot, or why there isn't one. Never throws (round-1 L6, round-2 T6). */
  async readSnapshot(jobId: string, revision: number): Promise<SnapshotRead> {
    let raw: unknown;
    try {
      raw = await this.#workspace.readJson(...this.#path(jobId, revision));
    } catch {
      return { kind: "unreadable" }; // unreadable, or not JSON at all
    }
    if (raw === undefined) return { kind: "missing" };
    const parsed = jobSnapshotSchema.safeParse(raw);
    return parsed.success ? { kind: "ok", snapshot: parsed.data } : { kind: "unreadable" }; // JSON, but not a snapshot
  }

  /** Undefined for a missing revision or a damaged one. */
  async getSnapshot(jobId: string, revision: number): Promise<JobSnapshot | undefined> {
    const read = await this.readSnapshot(jobId, revision);
    return read.kind === "ok" ? read.snapshot : undefined;
  }

  /** `jobId`'s summary: its latest revision when readable, the newest readable one, its url, and the damaged files stepped over to find them. Undefined when the job has no snapshot file at all. */
  async #summarise(jobId: string): Promise<JobSummary | undefined> {
    const numbers = await this.revisions(jobId);
    const latestRevisionNumber = numbers.at(-1);
    if (latestRevisionNumber === undefined) return undefined;
    const unreadable: UnreadableSnapshot[] = [];
    let newestReadable: JobSnapshot | undefined;
    for (let index = numbers.length - 1; index >= 0 && !newestReadable; index -= 1) {
      const revision = numbers[index]!;
      const read = await this.readSnapshot(jobId, revision);
      if (read.kind === "ok") newestReadable = read.snapshot;
      else if (read.kind === "unreadable") unreadable.push(this.#unreadable(jobId, revision));
    }
    return {
      jobId,
      revisionCount: numbers.length,
      latestRevisionNumber,
      ...(newestReadable && newestReadable.revision === latestRevisionNumber ? { latest: newestReadable } : {}),
      ...(newestReadable ? { newestReadable, url: newestReadable.url } : {}),
      unreadable,
    };
  }

  /**
   * Every job, newest capture first, including one whose latest revision is
   * damaged (round-2 T6: never a silent gap): it lists with the url of its
   * newest readable revision and its damaged files named. A job none of
   * whose revisions can be read still lists, sorted last.
   */
  async listJobs(): Promise<JobSummary[]> {
    const summaries: JobSummary[] = [];
    for (const jobId of (await this.#workspace.list(JOBS_DIR)).filter(isJobId)) {
      try {
        const summary = await this.#summarise(jobId);
        if (summary) summaries.push(summary);
      } catch {
        continue; // one job's own trouble (its directory replaced by a file mid-scan, say) never breaks the list for every other job
      }
    }
    summaries.sort((a, b) => (b.newestReadable?.capturedAt ?? "").localeCompare(a.newestReadable?.capturedAt ?? ""));
    return summaries;
  }

  /** Every revision of `jobId`, readable ones and damaged ones apart. Undefined when the job does not exist (no uuid directory, or no snapshot file in it). */
  async readJob(jobId: string): Promise<JobDetail | undefined> {
    if (!isJobId(jobId)) return undefined;
    let revisionNumbers: number[];
    try {
      revisionNumbers = await this.revisions(jobId);
    } catch {
      return undefined;
    }
    if (revisionNumbers.length === 0) return undefined;
    const revisions: JobSnapshot[] = [];
    const unreadable: UnreadableSnapshot[] = [];
    for (const revision of revisionNumbers) {
      const read = await this.readSnapshot(jobId, revision);
      if (read.kind === "ok") revisions.push(read.snapshot);
      else if (read.kind === "unreadable") unreadable.push(this.#unreadable(jobId, revision));
    }
    return { jobId, revisionNumbers, revisions, unreadable };
  }

  /** The readable revisions of `jobId`, oldest first. Undefined when the job does not exist. */
  async getJobRevisions(jobId: string): Promise<JobSnapshot[] | undefined> {
    const detail = await this.readJob(jobId);
    return detail ? [...detail.revisions] : undefined;
  }

  /**
   * The job that already captured `url`, if any. A job's url never changes
   * across its revisions, so the newest readable revision decides; damaged
   * revisions above it are stepped over (round-2 T6: a recapture lands in the
   * same job when any readable file of the job records the url).
   */
  async findJobIdByUrl(url: string): Promise<string | undefined> {
    for (const jobId of (await this.#workspace.list(JOBS_DIR)).filter(isJobId)) {
      try {
        const summary = await this.#summarise(jobId);
        if (summary?.url === url) return jobId;
      } catch {
        continue; // the same "one job's trouble is not every job's trouble" rule as listJobs
      }
    }
    return undefined;
  }

  /**
   * Saves a snapshot for `input.url`: a new job (revision 1) when the URL is
   * new; a new revision when its text's content hash differs from the latest
   * one's (or the latest can't be read); the existing latest revision,
   * unchanged, when it does not. `structured` starts `{}`: the caller queues
   * extraction afterwards only when `contentChanged` is true.
   */
  async captureJob(input: CaptureJobInput): Promise<CaptureJobResult> {
    return serialise(JOB_CHAINS, this.#workspace.root, () => this.#captureJobOnce(input));
  }

  async #captureJobOnce(input: CaptureJobInput): Promise<CaptureJobResult> {
    const contentHash = sha256Hex(input.text);
    for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
      const jobId = (await this.findJobIdByUrl(input.url)) ?? newId();
      const numbers = await this.revisions(jobId);
      const latestNumber = numbers.at(-1);
      if (latestNumber !== undefined) {
        const latest = await this.getSnapshot(jobId, latestNumber);
        if (latest && latest.contentHash === contentHash) {
          return { jobId, revision: latestNumber, isNewJob: false, contentChanged: false, snapshot: latest };
        }
      }
      const revision = (latestNumber ?? 0) + 1;
      const snapshot = jobSnapshotSchema.parse({
        jobId,
        revision,
        url: input.url,
        capturedAt: input.capturedAt,
        extractorVersion: input.extractorVersion,
        contentHash,
        text: input.text,
        structured: {},
      });
      const created = await this.#workspace.createJson(this.#path(jobId, revision), snapshot);
      if (created) return { jobId, revision, isNewJob: latestNumber === undefined, contentChanged: true, snapshot };
      // Lost a race for this exact (jobId, revision) file to another writer; loop and recompute against the new state.
    }
    throw new JobsStoreError(`Could not save a capture for ${input.url}: too many concurrent writers.`);
  }

  /**
   * Writes `structured` onto an existing, readable snapshot revision. Only
   * `captures.ts`'s extraction queue calls this, after an ok turn whose events
   * carry an accepted `extract_job` result for exactly this `jobId` and
   * `revision` (round-2 T1: the tool itself never writes). The fields are
   * re-validated here, since the store never trusts its caller's shape.
   */
  async recordStructured(jobId: string, revision: number, structured: JobStructured): Promise<RecordStructuredResult> {
    return serialise(JOB_CHAINS, this.#workspace.root, async () => {
      const existing = await this.getSnapshot(jobId, revision);
      if (!existing) return { ok: false, message: `No readable snapshot revision ${revision} for that job.` };
      const parsed = jobStructuredSchema.safeParse(structured);
      if (!parsed.success) return { ok: false, message: "The extracted fields did not match the expected shape." };
      const updated = jobSnapshotSchema.parse({ ...existing, structured: parsed.data });
      await this.#workspace.writeJson(this.#path(jobId, revision), updated);
      return { ok: true, message: "Saved the extracted fields.", snapshot: updated };
    });
  }
}
