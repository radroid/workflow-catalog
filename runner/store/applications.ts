import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  applicationSchema,
  claimKindSchema,
  claimStatusSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  uuidSchema,
  type Application,
} from "@workflow-catalog/contracts";
import { z } from "zod";
import type { Clock } from "../lib/clock.ts";
import { newId } from "../lib/crypto.ts";
import { draftSchema } from "../validate/draft-schema.ts";
import { writeFileAtomic } from "./atomic.ts";
import { serialise } from "./profile-writes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Applications (P05, mvp-spec §5): `applications/<taskId>.json` is the
 * contract's `Application` record, and `applications/<taskId>/` holds what
 * preparing it produced:
 *
 *   docs/resume-v<n>.md|docx|pdf, cover-v<n>.*, diff-v<n>.md   the documents (§5)
 *   versions/v<n>.json     one prepared version: the validated draft (with its
 *                          citations), the claims it cites, the per-sentence
 *                          diff and the changes since the version before
 *   preparation.json       the latest preparation attempt: running, parked on
 *                          gap questions, failed (and why), or done
 *
 * and `applications/details.json` holds the name and contact line the
 * person typed for their documents' header (never shown to the model).
 *
 * Every write to an application record goes through `update`, which bumps
 * the record's own `revision` (the contract's optimistic-concurrency
 * counter) and validates the result, one write at a time per workspace
 * (`APPLICATION_CHAINS`), so P06's board and P08's scheduler can use the same
 * store without losing each other's updates. One application per job:
 * `ensureForJob` finds it or creates it, under the same chain.
 *
 * Damaged files never throw out of a read: an application or preparation
 * file that can't be parsed reads as `unreadable`, by its workspace path.
 */

export const APPLICATIONS_DIR = "applications";
export const DETAILS_FILE = "details.json";
const APPLICATION_CHAINS = new Map<string, Promise<unknown>>();

export class ApplicationsStoreError extends Error {
  override readonly name = "ApplicationsStoreError";
}

export const PREPARATION_STATUSES = ["running", "parked", "failed", "done"] as const;
export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

export const REQUIREMENT_STATUSES = ["covered", "gap", "left_out", "not_a_requirement"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const GAP_ANSWERS = ["leave_out", "add_evidence"] as const;
export type GapAnswer = (typeof GAP_ANSWERS)[number];

/** A claim as a preparation recorded it: its label, and what the profile said about it then. */
export const preparedClaimSchema = z
  .object({
    label: z.string().regex(/^C\d{1,4}$/),
    id: uuidSchema,
    kind: claimKindSchema,
    status: claimStatusSchema,
    text: nonEmptyStringSchema,
  })
  .strict();
export type PreparedClaim = z.infer<typeof preparedClaimSchema>;

export const preparationProblemSchema = z
  .object({
    /** The validator rule the sentence broke (validate/validator.ts), or `requirements`: the page words it for the person. */
    rule: z.string(),
    where: z.string(),
    sentence: z.string(),
    message: nonEmptyStringSchema,
  })
  .strict();
export type PreparationProblem = z.infer<typeof preparationProblemSchema>;

export const preparationRecordSchema = z
  .object({
    attemptId: uuidSchema,
    status: z.enum(PREPARATION_STATUSES),
    /** The runner process working on a `running` attempt; another owner means it was interrupted. */
    owner: z.string().optional(),
    idempotencyKey: nonEmptyStringSchema,
    jobId: uuidSchema,
    jobRevision: z.number().int().positive(),
    profileVersion: z.number().int().positive(),
    coverLetter: z.boolean(),
    /** Every claim with its label: the confirmed ones the model is shown, and the rest, which it never is, for the validator. */
    claims: z.array(preparedClaimSchema),
    /** The posting's requirements as they were when the attempt started, by digest: the tool refuses if they changed. */
    requirementsDigest: nonEmptyStringSchema,
    requirementCount: z.number().int().nonnegative(),
    /** The person's answers to earlier gap questions, carried into the next attempt for the same key. */
    answers: z.array(
      z
        .object({ requirement: z.number().int().positive(), question: nonEmptyStringSchema, answer: z.enum(GAP_ANSWERS), answeredAt: isoDateTimeSchema })
        .strict(),
    ),
    /** Open gap questions, when the attempt parked on them. */
    questions: z.array(z.object({ requirement: z.number().int().positive(), question: nonEmptyStringSchema }).strict()),
    /** How the accepted (or parked) draft accounted for each requirement. */
    coverage: z
      .array(z.object({ requirement: z.number().int().positive(), status: z.enum(REQUIREMENT_STATUSES), labels: z.array(z.string()) }).strict())
      .optional(),
    /** The validator's refusals of the last draft, when the attempt failed on them. */
    problems: z.array(preparationProblemSchema),
    /** Why a failed attempt failed, in plain words. */
    error: nonEmptyStringSchema.optional(),
    runId: uuidSchema.optional(),
    /** The version a done attempt produced. */
    version: z.number().int().positive().optional(),
    startedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type PreparationRecord = z.infer<typeof preparationRecordSchema>;

const wordOpSchema = z.object({ kind: z.enum(["same", "added", "removed"]), text: z.string() }).strict();

export const statementDiffSchema = z
  .object({
    part: z.enum(["resume", "cover_letter"]),
    heading: z.string().optional(),
    section: z.number().int().nonnegative(),
    statement: z.number().int().nonnegative(),
    text: z.string(),
    labels: z.array(z.string()),
    sources: z.array(z.object({ label: z.string(), kind: claimKindSchema, text: z.string() }).strict()),
    ops: z.array(wordOpSchema).nullable(),
    change: z.enum(["same", "shortened", "reworded", "combined"]),
  })
  .strict();

export const versionChangeSchema = z
  .object({
    kind: z.enum(["added", "reworded", "removed", "unchanged"]),
    part: z.enum(["resume", "cover_letter"]),
    heading: z.string().optional(),
    text: z.string().optional(),
    labels: z.array(z.string()),
    noLongerConfirmed: z.array(z.string()).optional(),
  })
  .strict();

export const versionRecordSchema = z
  .object({
    version: z.number().int().positive(),
    replaces: z.number().int().positive().optional(),
    createdAt: isoDateTimeSchema,
    idempotencyKey: nonEmptyStringSchema,
    profileVersion: z.number().int().positive(),
    jobRevision: z.number().int().positive(),
    coverLetter: z.boolean(),
    draft: draftSchema,
    /** The confirmed claims the draft cites, as they read when it was prepared. */
    sources: z.array(preparedClaimSchema),
    statements: z.array(statementDiffSchema),
    changes: z.array(versionChangeSchema),
  })
  .strict();
export type VersionRecord = z.infer<typeof versionRecordSchema>;

export const personDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    contact: z.string().trim().max(160),
  })
  .strict();
export type PersonDetails = z.infer<typeof personDetailsSchema>;

export type ApplicationRead = { readonly kind: "ok"; readonly application: Application } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

export interface UnreadableApplication {
  readonly taskId: string;
  readonly path: string;
}

export interface ApplicationList {
  readonly applications: readonly Application[];
  readonly unreadable: readonly UnreadableApplication[];
}

const DOC_FILE = /^(?:resume|cover|diff)-v[1-9]\d*\.(?:md|docx|pdf)$/;

/** Whether `name` is a document file name P05 writes: `resume-v2.pdf`, `cover-v1.docx`, `diff-v3.md`. */
export function isDocumentFileName(name: string): boolean {
  return DOC_FILE.test(name);
}

/** A document's workspace-relative path, as `ApplicationDocument.path` records it. */
export function documentPath(taskId: string, fileName: string): string {
  return `${APPLICATIONS_DIR}/${taskId}/docs/${fileName}`;
}

/** An application record's workspace-relative path. */
export function applicationPath(taskId: string): string {
  return `${APPLICATIONS_DIR}/${taskId}.json`;
}

function isTaskId(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export class ApplicationsStore {
  readonly #workspace: Workspace;
  readonly #clock: Clock;

  constructor(workspace: Workspace, clock: Clock) {
    this.#workspace = workspace;
    this.#clock = clock;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    return serialise(APPLICATION_CHAINS, this.#workspace.root, work);
  }

  /** One application record, or why there isn't one. Never throws for a damaged file. */
  async read(taskId: string): Promise<ApplicationRead> {
    if (!isTaskId(taskId)) return { kind: "missing" };
    let raw: unknown;
    try {
      raw = await this.#workspace.readJson(APPLICATIONS_DIR, `${taskId}.json`);
    } catch {
      return { kind: "unreadable" };
    }
    if (raw === undefined) return { kind: "missing" };
    const parsed = applicationSchema.safeParse(raw);
    return parsed.success && parsed.data.taskId === taskId ? { kind: "ok", application: parsed.data } : { kind: "unreadable" };
  }

  async get(taskId: string): Promise<Application | undefined> {
    const read = await this.read(taskId);
    return read.kind === "ok" ? read.application : undefined;
  }

  /** Every application, readable ones and damaged ones apart. */
  async list(): Promise<ApplicationList> {
    const applications: Application[] = [];
    const unreadable: UnreadableApplication[] = [];
    for (const name of await this.#workspace.list(APPLICATIONS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const taskId = name.slice(0, -".json".length);
      if (!isTaskId(taskId)) continue;
      const read = await this.read(taskId);
      if (read.kind === "ok") applications.push(read.application);
      else if (read.kind === "unreadable") unreadable.push({ taskId, path: applicationPath(taskId) });
    }
    return { applications, unreadable };
  }

  /** The application for `jobId`, if there is one (one per job). */
  async findByJob(jobId: string): Promise<Application | undefined> {
    return (await this.list()).applications.find((application) => application.jobId === jobId);
  }

  /** The application for `jobId`, created at stage `saved` if there is none yet. */
  async ensureForJob(jobId: string): Promise<{ readonly application: Application; readonly created: boolean }> {
    if (!uuidSchema.safeParse(jobId).success) throw new ApplicationsStoreError("Not a job id.");
    return this.#serial(async () => {
      const existing = await this.findByJob(jobId);
      if (existing) return { application: existing, created: false };
      const application = applicationSchema.parse({
        taskId: newId(),
        jobId,
        stage: "saved",
        revision: 1,
        documents: [],
        notes: "",
        deadlines: [],
        processing: { status: "idle" },
      });
      const created = await this.#workspace.createJson([APPLICATIONS_DIR, `${application.taskId}.json`], application);
      if (!created) throw new ApplicationsStoreError("An application with that id already exists.");
      return { application, created: true };
    });
  }

  /**
   * Applies `change` to the current record and writes the result with its
   * `revision` bumped, one write at a time per workspace. `change` returns
   * undefined to write nothing. Throws ApplicationsStoreError when the record
   * is missing or damaged, and when the result isn't a valid Application
   * (the taskId and jobId can never change).
   */
  async update(taskId: string, change: (current: Application) => Application | undefined): Promise<Application> {
    return this.#serial(async () => {
      const read = await this.read(taskId);
      if (read.kind !== "ok") throw new ApplicationsStoreError(read.kind === "missing" ? "No such application." : `${applicationPath(taskId)} can't be read.`);
      const next = change(read.application);
      if (next === undefined) return read.application;
      const parsed = applicationSchema.safeParse({ ...next, taskId: read.application.taskId, jobId: read.application.jobId, revision: read.application.revision + 1 });
      if (!parsed.success) throw new ApplicationsStoreError("That change would not leave a valid application record, so nothing was written.");
      await this.#workspace.writeJson([APPLICATIONS_DIR, `${taskId}.json`], parsed.data);
      return parsed.data;
    });
  }

  // --- The latest preparation attempt ---------------------------------------

  async readPreparation(taskId: string): Promise<PreparationRecord | "unreadable" | undefined> {
    if (!isTaskId(taskId)) return undefined;
    let raw: unknown;
    try {
      raw = await this.#workspace.readJson(APPLICATIONS_DIR, taskId, "preparation.json");
    } catch {
      return "unreadable";
    }
    if (raw === undefined) return undefined;
    const parsed = preparationRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : "unreadable";
  }

  async writePreparation(taskId: string, record: PreparationRecord): Promise<void> {
    if (!isTaskId(taskId)) throw new ApplicationsStoreError("Not a task id.");
    await this.#workspace.writeJson([APPLICATIONS_DIR, taskId, "preparation.json"], preparationRecordSchema.parse({ ...record, updatedAt: this.#now() }));
  }

  // --- Prepared versions ----------------------------------------------------

  async readVersion(taskId: string, version: number): Promise<VersionRecord | undefined> {
    if (!isTaskId(taskId)) return undefined;
    try {
      const parsed = versionRecordSchema.safeParse(await this.#workspace.readJson(APPLICATIONS_DIR, taskId, "versions", `v${version}.json`));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every readable version record, oldest first. */
  async listVersions(taskId: string): Promise<VersionRecord[]> {
    if (!isTaskId(taskId)) return [];
    const numbers = (await this.#workspace.list(APPLICATIONS_DIR, taskId, "versions"))
      .map((name) => /^v([1-9]\d*)\.json$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const versions: VersionRecord[] = [];
    for (const number of numbers) {
      const record = await this.readVersion(taskId, number);
      if (record) versions.push(record);
    }
    return versions;
  }

  async writeVersion(taskId: string, record: VersionRecord): Promise<void> {
    if (!isTaskId(taskId)) throw new ApplicationsStoreError("Not a task id.");
    await this.#workspace.writeJson([APPLICATIONS_DIR, taskId, "versions", `v${record.version}.json`], versionRecordSchema.parse(record));
  }

  // --- Document files -------------------------------------------------------

  /** Writes one exported document atomically; returns its workspace-relative path. */
  async writeDocumentFile(taskId: string, fileName: string, data: string | Uint8Array): Promise<string> {
    if (!isTaskId(taskId) || !isDocumentFileName(fileName)) throw new ApplicationsStoreError("Not a document file name.");
    const file = await this.#workspace.resolveReal(APPLICATIONS_DIR, taskId, "docs", fileName);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, data);
    return documentPath(taskId, fileName);
  }

  /** One exported document's bytes, or undefined when it isn't there. */
  async readDocumentFile(taskId: string, fileName: string): Promise<Buffer | undefined> {
    if (!isTaskId(taskId) || !isDocumentFileName(fileName)) return undefined;
    try {
      return await readFile(await this.#workspace.resolveReal(APPLICATIONS_DIR, taskId, "docs", fileName));
    } catch {
      return undefined;
    }
  }

  // --- The documents' header --------------------------------------------------

  async readDetails(): Promise<PersonDetails | undefined> {
    try {
      const parsed = personDetailsSchema.safeParse(await this.#workspace.readJson(APPLICATIONS_DIR, DETAILS_FILE));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async writeDetails(details: PersonDetails): Promise<PersonDetails> {
    const parsed = personDetailsSchema.parse(details);
    await this.#workspace.writeJson([APPLICATIONS_DIR, DETAILS_FILE], parsed);
    return parsed;
  }
}
