import { jobSnapshotSchema, jobStructuredSchema, type JobSnapshot, type JobStructured } from "@workflow-catalog/contracts";
import { z } from "zod";
import { sha256Hex, newId } from "../lib/crypto.ts";
import { serialise } from "./profile-writes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Job snapshots (F6, mvp-spec §5): `jobs/<jobId>/snapshot-<rev>.json`, one
 * file per revision, `{ url, capturedAt, extractorVersion, contentHash, text,
 * structured }`. No separate index file: a job's directory name *is* its id,
 * and its url is read back from any one of its revisions (the url never
 * changes across a job's revisions). Local-first scale — a person's own saved
 * postings, at most a few hundred — so a full scan (`listJobs`,
 * `findJobIdByUrl`) is fine, the same trade-off `EventJournal.list` makes.
 *
 * `captureJob` and `recordStructured` both run under `serialise` (the
 * in-process per-workspace chain from `profile-writes.ts`, its own map here
 * so job writes are never queued behind profile writes): the bridge makes a
 * fresh `JobsStore` per request, so without it two nearly-simultaneous
 * captures of the same brand-new URL could each decide "no existing job" and
 * create two jobId directories for one URL.
 */

const JOBS_DIR = "jobs";
const SNAPSHOT_FILE = /^snapshot-(\d+)\.json$/;
const MAX_CAPTURE_ATTEMPTS = 5;
const JOB_CHAINS = new Map<string, Promise<unknown>>();

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
  /** False for the very first capture of a new job. */
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

export interface JobSummary {
  readonly jobId: string;
  readonly latestRevision: JobSnapshot;
  readonly revisionCount: number;
}

/**
 * Extraction status, kept beside a revision's snapshot rather than inside it
 * (`jobs/<jobId>/extraction-<rev>.json`) — round-1 review decision L5: the
 * contract's `jobSnapshotSchema` is `.strict()`, and adding a field to it is
 * outside this packet's `Owns` (`packages/contracts`), so this is P04's own
 * side-channel file, not part of the contract. `waiting`/`running` describe
 * a queued or in-flight extraction; `done` means the snapshot's `structured`
 * reflects a successful turn; `not_run` means no turn was even attempted
 * (`reason` says why: `runner_not_running`, `no_model`, `budget_paused`);
 * `failed` means a turn ran but didn't produce fields for this exact
 * revision (`reason`: `timed_out`, `turn_failed`, `no_fields_found`, or
 * `interrupted` — a `running` state a crashed earlier process left behind,
 * which `describeExtractionState` in `captures.ts` derives at read time by
 * checking its own in-process "currently running" set; never stored as
 * `interrupted` on disk, since the next real attempt overwrites it anyway).
 * These are stable string codes, not sentences: `runner/ui/assets/jobs.js`
 * owns the wording (never a raw server string in Jobs page UI text, the
 * same rule its `FRIENDLY_ERRORS` map already follows for capture errors).
 */
/** Reasons `captures.ts`'s `extractionPreflight` sets a revision straight to `not_run` without ever queuing a turn. */
export const EXTRACTION_NOT_RUN_REASONS = ["runner_not_running", "no_model", "budget_paused"] as const;
export type ExtractionNotRunReason = (typeof EXTRACTION_NOT_RUN_REASONS)[number];

/** Reasons a queued turn still ends in `failed` (`interrupted`: a `running` state a crashed earlier process left behind — `captures.ts`'s `describeExtractionState` derives this at read time; never written by `setExtractionState` itself). */
export const EXTRACTION_FAILURE_REASONS = ["timed_out", "turn_failed", "no_fields_found", "interrupted"] as const;
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

export const extractionStateSchema = z
  .object({
    status: z.enum(["waiting", "running", "done", "not_run", "failed"]),
    reason: z.enum([...EXTRACTION_NOT_RUN_REASONS, ...EXTRACTION_FAILURE_REASONS]).optional(),
    updatedAt: z.string(),
  })
  .strict();

export type ExtractionState = z.infer<typeof extractionStateSchema>;

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

  /** The extraction state beside `jobId`/`revision`'s snapshot, or `undefined` when none was ever recorded (a revision seeded or captured before any extraction attempt). */
  async getExtractionState(jobId: string, revision: number): Promise<ExtractionState | undefined> {
    const raw = await this.#workspace.readJson(...this.#extractionPath(jobId, revision));
    return raw === undefined ? undefined : extractionStateSchema.parse(raw);
  }

  /** Overwrites `jobId`/`revision`'s extraction state — the queue in `captures.ts` calls this at every transition (waiting → running → done/failed, or straight to not_run when a turn was never attempted). Not run under `serialise`: only one background task ever owns a given jobId/revision's state at a time (the queue itself is one-at-a-time per workspace), and a state read is never used to decide whether to write here. */
  async setExtractionState(jobId: string, revision: number, state: ExtractionState): Promise<void> {
    await this.#workspace.writeJson(this.#extractionPath(jobId, revision), extractionStateSchema.parse(state));
  }

  /** Revision numbers present for `jobId`, ascending. Empty when the job does not exist. */
  async revisions(jobId: string): Promise<number[]> {
    const names = await this.#workspace.list(JOBS_DIR, jobId);
    const numbers = names
      .map((name) => SNAPSHOT_FILE.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    return numbers.sort((a, b) => a - b);
  }

  async getSnapshot(jobId: string, revision: number): Promise<JobSnapshot | undefined> {
    const raw = await this.#workspace.readJson(...this.#path(jobId, revision));
    return raw === undefined ? undefined : jobSnapshotSchema.parse(raw);
  }

  /** Every job, its latest revision, and how many revisions it has — the Jobs page's list. Newest capture first. */
  async listJobs(): Promise<JobSummary[]> {
    const jobIds = await this.#workspace.list(JOBS_DIR);
    const summaries: JobSummary[] = [];
    for (const jobId of jobIds) {
      const numbers = await this.revisions(jobId);
      const latestNumber = numbers.at(-1);
      if (latestNumber === undefined) continue;
      const latestRevision = await this.getSnapshot(jobId, latestNumber);
      if (!latestRevision) continue;
      summaries.push({ jobId, latestRevision, revisionCount: numbers.length });
    }
    summaries.sort((a, b) => b.latestRevision.capturedAt.localeCompare(a.latestRevision.capturedAt));
    return summaries;
  }

  /** Every revision of `jobId`, oldest first (for the revisions list and the "posting changed" diff). Undefined when the job does not exist. */
  async getJobRevisions(jobId: string): Promise<JobSnapshot[] | undefined> {
    const numbers = await this.revisions(jobId);
    if (numbers.length === 0) return undefined;
    const snapshots: JobSnapshot[] = [];
    for (const revision of numbers) {
      const snapshot = await this.getSnapshot(jobId, revision);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  /** The job that already captured `url`, if any — a job's url never changes across its revisions, so its first revision alone is enough to check. */
  async findJobIdByUrl(url: string): Promise<string | undefined> {
    for (const jobId of await this.#workspace.list(JOBS_DIR)) {
      const numbers = await this.revisions(jobId);
      const first = numbers[0];
      if (first === undefined) continue;
      const snapshot = await this.getSnapshot(jobId, first);
      if (snapshot?.url === url) return jobId;
    }
    return undefined;
  }

  /**
   * Saves a snapshot for `input.url`: a new job (revision 1) when the URL is
   * new; a new revision when its text's content hash changed from the
   * latest one; the existing latest revision, unchanged, when it did not.
   * `structured` starts `{}` — a caller runs extraction afterward only when
   * `contentChanged` is true (`captures.ts`), since re-extracting unchanged
   * text would just repeat the same model call for no new information.
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
   * Writes `structured` onto an existing snapshot revision. Called only by
   * the `extract_job` tool with a `jobId`/`revision` it was given, never free
   * text (iter-003 decision: model tools take IDs only) — so this is the
   * check that the id actually names a snapshot that exists, not a
   * verification of the fields' content the way `extract_claims` verifies an
   * evidence quote (job-structured fields carry no evidence pointer to check
   * against).
   */
  async recordStructured(jobId: string, revision: number, structured: JobStructured): Promise<RecordStructuredResult> {
    return serialise(JOB_CHAINS, this.#workspace.root, async () => {
      const existing = await this.getSnapshot(jobId, revision);
      if (!existing) return { ok: false, message: `No snapshot revision ${revision} for that job.` };
      const parsed = jobStructuredSchema.safeParse(structured);
      if (!parsed.success) return { ok: false, message: "The extracted fields did not match the expected shape." };
      const updated = jobSnapshotSchema.parse({ ...existing, structured: parsed.data });
      await this.#workspace.writeJson(this.#path(jobId, revision), updated);
      return { ok: true, message: "Saved the extracted fields.", snapshot: updated };
    });
  }
}
