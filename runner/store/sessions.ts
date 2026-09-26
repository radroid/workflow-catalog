import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import {
  applicationStatusChangedSchema,
  browserCommandItemStatusSchema,
  browserCommandResultSchema,
  browserCommandResultStatusSchema,
  isoDateTimeSchema,
  jobCaptureSchema,
  MAX_APPLICATION_GROUP_SIZE,
  MAX_BRIDGE_BODY_BYTES,
  nonEmptyStringSchema,
  openApplicationGroupSchema,
  sessionManifestSchema,
  uuidSchema,
  type Application,
  type ApplicationStage,
  type ApplicationStatusChanged,
  type BrowserCommandItemStatus,
  type BrowserCommandResult,
  type OpenApplicationGroup,
  type SessionManifest,
} from "@workflow-catalog/contracts";
import { z } from "zod";
import { MINUTE_MS, type Clock } from "../lib/clock.ts";
import { newId, sha256Hex } from "../lib/crypto.ts";
import { isBlockedAddress } from "../lib/safe-fetch.ts";
import { ApplicationsStore } from "./applications.ts";
import type { CommandQueue, CommandRecord } from "./commands.ts";
import { DeviceRegistry, type DeviceRecord } from "./devices.ts";
import { JobsStore } from "./jobs.ts";
import { serialise } from "./profile-writes.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Application sessions (P06, mvp-spec F9 and §5): the Ready applications the
 * person chose to open together as one tab group, and everything the browser
 * and the person said about them since.
 *
 *   sessions/<sessionId>.json         the session manifest, exactly the contract's `SessionManifest`
 *   sessions/<sessionId>/state.json   the runner's record of it (below): the device and command it went out
 *                                     as, each item's tab and the person's choice, and what needs review
 *   sessions/inbox-ledger.json        which `inbox/` files were imported, and what came of each event
 *   outbox/application-session.json   the file-bridge fallback: a manifest for the extension to import by hand
 *
 * The rules (docs/spec/research/browser-boundary.md, "Minimal protocol contract"):
 *
 * - A session holds Ready applications only, at most MAX_APPLICATION_GROUP_SIZE, and names each by its task
 *   ID. Every URL is the job's stored capture URL (`JobSnapshot.url`) for the revision its newest documents
 *   were prepared from, never anything a posting says (not even `structured.applyUrl`), and it must be https
 *   to a public host: nothing a posting says can become a navigation target.
 * - Its command (`open_application_group`) carries an expiry, the workflow version, the paired device it is
 *   for, and at most MAX_APPLICATION_GROUP_SIZE items. With no paired browser there is no command: the session
 *   is written to `outbox/` for the extension to import by hand.
 * - Only the person's explicit choice moves a stage: `application_status_changed` with `applied`, at the
 *   revision the browser last saw. A stale revision is refused, never merged. `deferred` is recorded and moves
 *   nothing. A tab result (`browser_command_result`), `closed` included, never moves a stage. Unknown, missing,
 *   failed or partial results are flagged for review on the Sessions page, never guessed.
 * - A result for a command addressed to another device, or for a task no session of this device holds, is
 *   refused. So is a first report on a command after it expired.
 * - Every event is applied once. The bridge journal already stores each eventId once; these records also
 *   remember every eventId they applied, so a retried dispatch, or the same event arriving again from an
 *   `inbox/` file, has no second effect.
 *
 * Read-modify-write of these records is serialised per workspace (SESSION_CHAINS), in the bridge's process.
 * The model's tool (`open_application_group`, in eve's process) only ever creates new files, exclusively.
 */

export const SESSIONS_DIR = "sessions";
export const OUTBOX_DIR = "outbox";
export const INBOX_DIR = "inbox";
export const OUTBOX_FILE = "application-session.json";
export const INBOX_LEDGER_FILE = "inbox-ledger.json";
export const STATE_FILE = "state.json";
/** How long a command may wait for the browser: a day, so "Apply today" still opens tomorrow morning, and never after. */
export const COMMAND_TTL_MS = 24 * 60 * MINUTE_MS;
export const DEFAULT_SESSION_TITLE = "Apply today";
export const MAX_SESSION_TITLE_LENGTH = 80;
export const MAX_INBOX_FILES = 50;
const SESSION_CHAINS = new Map<string, Promise<unknown>>();

export const TAB_STATUSES = browserCommandItemStatusSchema.options;
export const CHOICES = ["applied", "deferred"] as const;
/** Stages an explicit "applied" can move on from. A later stage is the person's own newer status, never reset by one. */
const BEFORE_APPLIED: ReadonlySet<ApplicationStage> = new Set(["saved", "preparing", "ready"]);

export const FLAG_KINDS = ["failed", "partial", "item_failed", "item_skipped", "closed", "missing", "unknown_task", "conflict"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

const revisionSchema = z.number().int().positive();
const sourceSchema = z.enum(["bridge", "inbox"]);

export const sessionItemSchema = z
  .object({
    taskId: uuidSchema,
    jobId: uuidSchema,
    jobRevision: revisionSchema,
    url: z.string(),
    /** The application's revision when the session was made. */
    revisionAtStart: revisionSchema,
    /** The browser's latest report on this item's tab. */
    tab: z.object({ status: browserCommandItemStatusSchema, at: isoDateTimeSchema, eventId: uuidSchema }).strict().optional(),
    /** The person's explicit choice for it, from the side panel or an import. */
    choice: z.object({ status: z.enum(CHOICES), at: isoDateTimeSchema, eventId: uuidSchema, revision: revisionSchema }).strict().optional(),
  })
  .strict();
export type SessionItem = z.infer<typeof sessionItemSchema>;

export const sessionFlagSchema = z
  .object({
    flagId: uuidSchema,
    kind: z.enum(FLAG_KINDS),
    taskId: uuidSchema.optional(),
    eventId: uuidSchema,
    at: isoDateTimeSchema,
    reviewedAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type SessionFlag = z.infer<typeof sessionFlagSchema>;

const resultEntrySchema = z.object({ eventId: uuidSchema, status: browserCommandResultStatusSchema, at: isoDateTimeSchema, source: sourceSchema }).strict();

/** One explicit status change: written before the application is, and completed with its outcome after. */
const changeEntrySchema = z
  .object({
    eventId: uuidSchema,
    taskId: uuidSchema,
    status: z.enum(CHOICES),
    expectedRevision: revisionSchema,
    at: isoDateTimeSchema,
    source: sourceSchema,
    outcome: z.enum(["applied", "deferred", "already_applied", "refused"]).optional(),
    /** The application's revision once the change was done. */
    revision: revisionSchema.optional(),
  })
  .strict();
type ChangeEntry = z.infer<typeof changeEntrySchema>;

export const sessionRecordSchema = z
  .object({
    sessionId: uuidSchema,
    title: nonEmptyStringSchema,
    createdAt: isoDateTimeSchema,
    /** The paired browser its command went to; absent for a session only the file bridge carries. */
    deviceId: uuidSchema.optional(),
    commandId: uuidSchema.optional(),
    workflowVersion: nonEmptyStringSchema,
    expiresAt: isoDateTimeSchema,
    items: z.array(sessionItemSchema).min(1).max(MAX_APPLICATION_GROUP_SIZE),
    results: z.array(resultEntrySchema),
    changes: z.array(changeEntrySchema),
    flags: z.array(sessionFlagSchema),
    /** When its manifest was last written to `outbox/`. */
    outboxAt: isoDateTimeSchema.optional(),
  })
  .strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

const ledgerEntrySchema = z
  .object({
    name: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    importedAt: isoDateTimeSchema,
    outcomes: z.array(z.object({ eventId: uuidSchema, outcome: z.string() }).strict()),
  })
  .strict();
const ledgerSchema = z.object({ imports: z.array(ledgerEntrySchema) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;

// --- Decisions (pure) ------------------------------------------------------------

export type Refusal = { readonly kind: "refused"; readonly status: 403 | 404 | 409 | 410; readonly code: string; readonly message: string };

function refusal(status: Refusal["status"], code: string, message: string): Refusal {
  return { kind: "refused", status, code, message };
}

export type StatusDecision = { readonly kind: "move"; readonly stage: "applied" } | { readonly kind: "record"; readonly outcome: "deferred" | "already_applied" } | Refusal;

/**
 * What the person's explicit status does to `application`, decided from the application alone: a stale
 * revision is refused (never merged); `deferred` moves nothing; `applied` moves a stage before Applied to
 * Applied, leaves Applied as it is, and never resets a later stage the person chose since.
 */
export function decideStatusChange(application: Application | undefined, event: Pick<ApplicationStatusChanged, "status" | "expectedRevision">): StatusDecision {
  if (!application) return refusal(404, "application_not_found", "The runner has no such application.");
  if (event.expectedRevision !== application.revision) {
    return refusal(409, "stale_revision", "This application changed since the browser last saw it, so nothing changed. Refresh the side panel and choose again.");
  }
  if (event.status === "deferred") return { kind: "record", outcome: "deferred" };
  if (application.stage === "applied") return { kind: "record", outcome: "already_applied" };
  if (!BEFORE_APPLIED.has(application.stage)) return refusal(409, "stage_moved_on", "This application has moved past Applied on the board, so nothing changed.");
  return { kind: "move", stage: "applied" };
}

/**
 * The URL a command may carry for a stored job URL, or why not: https only, no credentials, and a public host
 * (no loopback, private, link-local or metadata address, and no single-label or local-only name).
 */
export function commandUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "has_credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host)) return isBlockedAddress(host) ? "private_host" : undefined;
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host)) return "private_host";
  return undefined;
}

/** "job-assistant@0": the package name and its major version, so the extension can refuse a major it doesn't know. */
export function workflowVersionOf(packageVersion: string): string {
  return `job-assistant@${packageVersion.split(".")[0] ?? "0"}`;
}

// --- The store ------------------------------------------------------------------------

export interface CreateSessionInput {
  readonly taskIds: readonly string[];
  readonly title?: string;
}

export type SessionRefusalCode =
  | "no_tasks"
  | "too_many"
  | "duplicate_task"
  | "application_not_found"
  | "not_ready"
  | "no_documents"
  | "job_unreadable"
  | "url_not_allowed"
  | "already_waiting"
  | "bad_title";

export type CreateSessionResult =
  | { readonly ok: true; readonly record: SessionRecord; readonly manifest: SessionManifest; readonly command?: OpenApplicationGroup; readonly device?: DeviceRecord }
  | { readonly ok: false; readonly code: SessionRefusalCode; readonly taskId?: string; readonly detail?: string };

export interface ApplyContext {
  readonly commands: CommandQueue;
  readonly receivedAt: Date;
  /** The authenticated device (the bridge); absent for an import the person made from `inbox/`. */
  readonly deviceId?: string;
  readonly source: "bridge" | "inbox";
}

export type ResultOutcome =
  | Refusal
  | {
      readonly kind: "applied" | "duplicate";
      readonly sessionId: string;
      /** Each of the command's applications as it is now: the extension learns the revision it must name next. */
      readonly items: ReadonlyArray<{ readonly taskId: string; readonly stage: ApplicationStage; readonly revision: number }>;
      readonly flagged: number;
    };

export type ChangeOutcome =
  | Refusal
  | { readonly kind: "applied" | "duplicate"; readonly outcome: "applied" | "deferred" | "already_applied"; readonly sessionId: string; readonly taskId: string; readonly stage: ApplicationStage; readonly revision: number };

export type InboxEventPlan =
  | { readonly type: "browser_command_result" | "application_status_changed"; readonly eventId: string; readonly taskIds: readonly string[]; readonly plan: "apply" | "already" | "refused"; readonly code?: string; readonly status?: string }
  | { readonly type: "job_capture"; readonly eventId: string; readonly taskIds: readonly string[]; readonly plan: "not_here" };

export interface InboxFile {
  readonly name: string;
  readonly kind: "events" | "session" | "too_large" | "unreadable" | "unknown";
  readonly bytes: number;
  readonly sha256?: string;
  readonly importedAt?: string;
  readonly events: readonly InboxEventPlan[];
  /** For a session manifest: whether it is one of this workspace's sessions. */
  readonly session?: { readonly sessionId: string; readonly known: boolean; readonly title: string };
  /** Entries that aren't events this page reads. */
  readonly skipped: number;
}

const INBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.json$/;
const inboxEventSchema = z.discriminatedUnion("type", [browserCommandResultSchema, applicationStatusChangedSchema, jobCaptureSchema]);

function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export class SessionsStore {
  readonly #workspace: Workspace;
  readonly #clock: Clock;

  constructor(workspace: Workspace, clock: Clock) {
    this.#workspace = workspace;
    this.#clock = clock;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    return serialise(SESSION_CHAINS, this.#workspace.root, work);
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  // --- Reading ------------------------------------------------------------------------

  async readManifest(sessionId: string): Promise<SessionManifest | undefined> {
    if (!isUuid(sessionId)) return undefined;
    try {
      const parsed = sessionManifestSchema.safeParse(await this.#workspace.readJson(SESSIONS_DIR, `${sessionId}.json`));
      return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async read(sessionId: string): Promise<SessionRecord | undefined> {
    if (!isUuid(sessionId)) return undefined;
    try {
      const parsed = sessionRecordSchema.safeParse(await this.#workspace.readJson(SESSIONS_DIR, sessionId, STATE_FILE));
      return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every readable session record, newest first; and the session folders whose record can't be read. */
  async list(): Promise<{ readonly sessions: SessionRecord[]; readonly unreadable: string[] }> {
    const sessions: SessionRecord[] = [];
    const unreadable: string[] = [];
    for (const name of await this.#workspace.list(SESSIONS_DIR)) {
      if (!isUuid(name)) continue;
      const record = await this.read(name);
      if (record) sessions.push(record);
      else unreadable.push(`${SESSIONS_DIR}/${name}/${STATE_FILE}`);
    }
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId));
    return { sessions, unreadable };
  }

  async #write(record: SessionRecord): Promise<void> {
    await this.#workspace.writeJson([SESSIONS_DIR, record.sessionId, STATE_FILE], sessionRecordSchema.parse(record));
  }

  /** Whether `record`'s command still waits for the browser: queued or delivered, not reported, not expired. */
  static commandPending(record: SessionRecord, command: CommandRecord | undefined, now: Date): boolean {
    if (!record.commandId || !command || command.acknowledgedAt) return false;
    return new Date(command.command.expiresAt).getTime() > now.getTime();
  }

  // --- Starting a session ------------------------------------------------------------

  /**
   * Makes a session from Ready applications, by task ID only: the manifest, the runner's record, and, when a
   * browser is paired, one `open_application_group` command for it (the most recently paired active device).
   * With none, the manifest goes to `outbox/` for the extension to import by hand. Refuses the whole session,
   * naming the first application at fault, when any one can't go.
   */
  async create(input: CreateSessionInput, commands: CommandQueue): Promise<CreateSessionResult> {
    const taskIds = [...input.taskIds];
    if (taskIds.length === 0) return { ok: false, code: "no_tasks" };
    if (taskIds.length > MAX_APPLICATION_GROUP_SIZE) return { ok: false, code: "too_many" };
    const seen = new Set<string>();
    for (const taskId of taskIds) {
      if (seen.has(taskId)) return { ok: false, code: "duplicate_task", taskId };
      seen.add(taskId);
    }
    const title = (input.title ?? DEFAULT_SESSION_TITLE).replace(/\s+/g, " ").trim();
    if (title.length === 0 || title.length > MAX_SESSION_TITLE_LENGTH) return { ok: false, code: "bad_title" };

    return this.#serial(async () => {
      const applications = new ApplicationsStore(this.#workspace, this.#clock);
      const jobs = new JobsStore(this.#workspace);
      const items: SessionItem[] = [];
      for (const taskId of taskIds) {
        const application = isUuid(taskId) ? await applications.get(taskId) : undefined;
        if (!application) return { ok: false, code: "application_not_found", taskId };
        if (application.stage !== "ready") return { ok: false, code: "not_ready", taskId };
        const newest = application.documents.reduce<number | undefined>((best, document) => (best === undefined || document.version > best ? document.version : best), undefined);
        const jobRevision = application.documents.find((document) => document.version === newest)?.jobRevision;
        if (jobRevision === undefined) return { ok: false, code: "no_documents", taskId };
        const snapshot = await jobs.getSnapshot(application.jobId, jobRevision);
        if (!snapshot) return { ok: false, code: "job_unreadable", taskId };
        // The stored capture URL, never a URL the posting's text named (structured.applyUrl included).
        const problem = commandUrlProblem(snapshot.url);
        if (problem) return { ok: false, code: "url_not_allowed", taskId, detail: problem };
        items.push({ taskId, jobId: application.jobId, jobRevision, url: snapshot.url, revisionAtStart: application.revision });
      }

      // A task still waiting to open in another session's command would open twice (in this browser or another one).
      const now = this.#clock.now();
      for (const other of (await this.list()).sessions) {
        const command = other.commandId ? await commands.get(other.commandId) : undefined;
        if (!SessionsStore.commandPending(other, command, now)) continue;
        const clash = items.find((item) => other.items.some((entry) => entry.taskId === item.taskId));
        if (clash) return { ok: false, code: "already_waiting", taskId: clash.taskId };
      }

      const device = (await new DeviceRegistry(this.#workspace, this.#clock).active()).at(-1);
      const sessionId = newId();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + COMMAND_TTL_MS).toISOString();
      const workflowVersion = workflowVersionOf(this.#workspace.manifest.packageVersion);
      const manifest = sessionManifestSchema.parse({
        protocol: 1,
        sessionId,
        title,
        items: items.map((item) => ({ taskId: item.taskId, jobRevision: item.jobRevision, url: item.url })),
        createdAt,
      });
      const command = device
        ? openApplicationGroupSchema.parse({
            protocol: 1,
            type: "open_application_group",
            commandId: newId(),
            deviceId: device.deviceId,
            sessionId,
            workflowVersion,
            expiresAt,
            payload: { title, items: manifest.items },
          })
        : undefined;
      const record = sessionRecordSchema.parse({
        sessionId,
        title,
        createdAt,
        ...(device && command ? { deviceId: device.deviceId, commandId: command.commandId } : {}),
        workflowVersion,
        expiresAt,
        items,
        results: [],
        changes: [],
        flags: [],
      });
      // The record first, then the manifest, then the command: a runner that stops in between leaves a session
      // the Sessions page shows as never sent (and can still write to outbox/), never a command with no record.
      await this.#workspace.createJson([SESSIONS_DIR, sessionId, STATE_FILE], record);
      await this.#workspace.createJson([SESSIONS_DIR, `${sessionId}.json`], manifest);
      if (command) await commands.enqueue(command);
      else await this.#writeOutbox(record, manifest);
      return { ok: true, record: (await this.read(sessionId)) ?? record, manifest, ...(command ? { command } : {}), ...(device ? { device } : {}) };
    });
  }

  // --- The outbox --------------------------------------------------------------------------

  async #writeOutbox(record: SessionRecord, manifest: SessionManifest): Promise<SessionRecord> {
    await this.#workspace.writeJson([OUTBOX_DIR, OUTBOX_FILE], manifest);
    const next = { ...record, outboxAt: this.#now() };
    await this.#write(next);
    return next;
  }

  /** Writes a session's manifest to `outbox/application-session.json`, for the extension's file import. */
  async writeOutbox(sessionId: string): Promise<SessionRecord | undefined> {
    return this.#serial(async () => {
      const record = await this.read(sessionId);
      const manifest = await this.readManifest(sessionId);
      if (!record || !manifest) return undefined;
      return this.#writeOutbox(record, manifest);
    });
  }

  /** What `outbox/application-session.json` holds now. */
  async readOutbox(): Promise<{ readonly present: boolean; readonly manifest?: SessionManifest; readonly readable: boolean }> {
    let raw: unknown;
    try {
      raw = await this.#workspace.readJson(OUTBOX_DIR, OUTBOX_FILE);
    } catch {
      return { present: true, readable: false };
    }
    if (raw === undefined) return { present: false, readable: true };
    const parsed = sessionManifestSchema.safeParse(raw);
    return parsed.success ? { present: true, readable: true, manifest: parsed.data } : { present: true, readable: false };
  }

  // --- Review ------------------------------------------------------------------------------

  /** Marks one flagged result as reviewed. Idempotent. */
  async reviewFlag(sessionId: string, flagId: string): Promise<SessionRecord | undefined> {
    return this.#serial(async () => {
      const record = await this.read(sessionId);
      if (!record || !record.flags.some((flag) => flag.flagId === flagId)) return undefined;
      if (record.flags.every((flag) => flag.flagId !== flagId || flag.reviewedAt)) return record;
      const next = { ...record, flags: record.flags.map((flag) => (flag.flagId === flagId && !flag.reviewedAt ? { ...flag, reviewedAt: this.#now() } : flag)) };
      await this.#write(next);
      return next;
    });
  }

  // --- The browser's reports ------------------------------------------------------------

  /** Applies a `browser_command_result`: records each item's tab, flags what needs review, and retires the command. */
  async applyCommandResult(event: BrowserCommandResult, context: ApplyContext): Promise<ResultOutcome> {
    return this.#serial(() => this.#applyCommandResult(event, context));
  }

  async #itemsNow(record: SessionRecord): Promise<Array<{ taskId: string; stage: ApplicationStage; revision: number }>> {
    const applications = new ApplicationsStore(this.#workspace, this.#clock);
    const out: Array<{ taskId: string; stage: ApplicationStage; revision: number }> = [];
    for (const item of record.items) {
      const application = await applications.get(item.taskId);
      if (application) out.push({ taskId: item.taskId, stage: application.stage, revision: application.revision });
    }
    return out;
  }

  async #findByCommand(commandId: string, sessionId: string): Promise<SessionRecord | undefined> {
    const record = await this.read(sessionId);
    return record?.commandId === commandId ? record : undefined;
  }

  async #planCommandResult(event: BrowserCommandResult, context: ApplyContext): Promise<{ readonly refused?: Refusal; readonly record?: SessionRecord; readonly command?: CommandRecord; readonly duplicate?: boolean }> {
    const command = await context.commands.get(event.commandId);
    if (!command) return { refused: refusal(404, "unknown_command", "The runner never sent that command.") };
    if (context.deviceId !== undefined && command.command.deviceId !== context.deviceId) {
      return { refused: refusal(403, "command_not_for_device", "That command was sent to another browser, so this one can't report on it.") };
    }
    const record = await this.#findByCommand(event.commandId, command.command.sessionId);
    if (!record) return { refused: refusal(404, "unknown_session", "The runner has no session for that command.") };
    if (record.results.some((entry) => entry.eventId === event.eventId)) return { record, command, duplicate: true };
    if (!command.acknowledgedAt && context.receivedAt.getTime() >= new Date(command.command.expiresAt).getTime()) {
      return { refused: refusal(410, "command_expired", "That session expired before the browser reported on it, so nothing was recorded.") };
    }
    return { record, command };
  }

  async #applyCommandResult(event: BrowserCommandResult, context: ApplyContext): Promise<ResultOutcome> {
    const planned = await this.#planCommandResult(event, context);
    if (planned.refused) return planned.refused;
    const record = planned.record!;
    const command = planned.command!;
    if (planned.duplicate) {
      // Retried after the record was written (a crash before the acknowledgement, say): finish, change nothing else.
      await context.commands.acknowledge(event.commandId, command.command.deviceId);
      return { kind: "duplicate", sessionId: record.sessionId, items: await this.#itemsNow(record), flagged: 0 };
    }

    const at = context.receivedAt.toISOString();
    const inCommand = new Set(command.command.payload.items.map((item) => item.taskId));
    const reported = new Map<string, Set<string>>();
    for (const item of event.items) reported.set(item.taskId, (reported.get(item.taskId) ?? new Set()).add(item.status));
    const flags: SessionFlag[] = [];
    const flag = (kind: FlagKind, taskId?: string) => flags.push({ flagId: newId(), kind, ...(taskId ? { taskId } : {}), eventId: event.eventId, at });

    const items = record.items.map((item) => {
      const statuses = reported.get(item.taskId);
      if (!statuses) return item;
      if (statuses.size > 1) {
        flag("conflict", item.taskId); // two different answers for one tab: never guessed
        return item;
      }
      const status = [...statuses][0] as BrowserCommandItemStatus;
      if (status === "failed") flag("item_failed", item.taskId);
      if (status === "skipped") flag("item_skipped", item.taskId);
      // A closed tab records only that it closed (browser-boundary.md): with no choice made, the person reviews it.
      if (status === "closed" && !item.choice) flag("closed", item.taskId);
      return { ...item, tab: { status, at, eventId: event.eventId } };
    });
    for (const taskId of reported.keys()) if (!inCommand.has(taskId)) flag("unknown_task", taskId);
    // The first report must account for every tab; a later one (a tab closed, say) names only the tabs it is about.
    if (record.results.length === 0) for (const taskId of inCommand) if (!reported.has(taskId)) flag("missing", taskId);
    if (flags.length === 0 && event.status !== "completed") flag(event.status === "failed" ? "failed" : "partial");

    const next: SessionRecord = {
      ...record,
      items,
      results: [...record.results, { eventId: event.eventId, status: event.status, at, source: context.source }],
      flags: [...record.flags, ...flags],
    };
    await this.#write(next);
    await context.commands.acknowledge(event.commandId, command.command.deviceId);
    return { kind: "applied", sessionId: record.sessionId, items: await this.#itemsNow(next), flagged: flags.length };
  }

  /** Applies the person's explicit `application_status_changed`: the only thing, besides the board, that moves a stage. */
  async applyStatusChange(event: ApplicationStatusChanged, context: ApplyContext): Promise<ChangeOutcome> {
    return this.#serial(() => this.#applyStatusChange(event, context));
  }

  /** The newest session holding `taskId` (for `deviceId`, when the bridge names one), and any earlier entry for this eventId. */
  async #sessionFor(taskId: string, eventId: string, deviceId: string | undefined): Promise<{ readonly record?: SessionRecord; readonly earlier?: { record: SessionRecord; entry: ChangeEntry } }> {
    const { sessions } = await this.list();
    for (const record of sessions) {
      const entry = record.changes.find((change) => change.eventId === eventId);
      if (entry) return { earlier: { record, entry } };
    }
    return { record: sessions.find((record) => record.items.some((item) => item.taskId === taskId) && (deviceId === undefined || record.deviceId === deviceId)) };
  }

  async #applyStatusChange(event: ApplicationStatusChanged, context: ApplyContext): Promise<ChangeOutcome> {
    const applications = new ApplicationsStore(this.#workspace, this.#clock);
    const found = await this.#sessionFor(event.taskId, event.eventId, context.deviceId);
    const at = context.receivedAt.toISOString();

    if (found.earlier) {
      const { record, entry } = found.earlier;
      if (entry.outcome === "refused") return refusal(409, "stale_revision", "This application changed since the browser last saw it, so nothing changed. Refresh the side panel and choose again.");
      if (entry.outcome) {
        const application = await applications.get(event.taskId);
        return { kind: "duplicate", outcome: entry.outcome, sessionId: record.sessionId, taskId: event.taskId, stage: application?.stage ?? "applied", revision: application?.revision ?? entry.revision ?? entry.expectedRevision };
      }
      // Written before the application, never finished (the runner stopped between the two): finish it now.
      return this.#finishMove(record, entry, applications, at);
    }

    const record = found.record;
    if (!record) {
      return context.deviceId === undefined
        ? refusal(404, "task_not_in_session", "That application isn't in any of the runner's sessions, so nothing changed.")
        : refusal(403, "task_not_for_device", "That application wasn't sent to this browser, so it can't change it.");
    }
    const application = await applications.get(event.taskId);
    const decision = decideStatusChange(application, event);
    if (decision.kind === "refused") return decision;
    const entry: ChangeEntry = { eventId: event.eventId, taskId: event.taskId, status: event.status, expectedRevision: event.expectedRevision, at, source: context.source };
    if (decision.kind === "record") {
      const done: ChangeEntry = { ...entry, outcome: decision.outcome, revision: application!.revision };
      await this.#write(this.#withChange(record, done));
      return { kind: "applied", outcome: decision.outcome, sessionId: record.sessionId, taskId: event.taskId, stage: application!.stage, revision: application!.revision };
    }
    // Intent first, then the application, then the outcome: a retry after a stop in between finishes the same move.
    const intended = this.#withChange(record, entry);
    await this.#write(intended);
    return this.#finishMove(intended, entry, applications, at);
  }

  async #finishMove(record: SessionRecord, entry: ChangeEntry, applications: ApplicationsStore, at: string): Promise<ChangeOutcome> {
    let moved = false;
    const current = await applications.update(entry.taskId, (application) => {
      const decision = decideStatusChange(application, entry);
      if (decision.kind !== "move") return undefined;
      moved = true;
      return { ...application, stage: decision.stage };
    });
    // Not moved: either an earlier attempt already moved it (Applied at the next revision), or something else wrote first.
    const alreadyDone = !moved && current.stage === "applied" && current.revision === entry.expectedRevision + 1;
    const outcome = moved || alreadyDone ? "applied" : "refused";
    const done: ChangeEntry = { ...entry, outcome, revision: current.revision };
    await this.#write(this.#withChange(record, done, at));
    if (outcome === "refused") return refusal(409, "stale_revision", "This application changed since the browser last saw it, so nothing changed. Refresh the side panel and choose again.");
    return { kind: "applied", outcome: "applied", sessionId: record.sessionId, taskId: entry.taskId, stage: current.stage, revision: current.revision };
  }

  #withChange(record: SessionRecord, entry: ChangeEntry, at = entry.at): SessionRecord {
    const changes = [...record.changes.filter((change) => change.eventId !== entry.eventId), entry];
    const decided = entry.outcome === "applied" || entry.outcome === "deferred" || entry.outcome === "already_applied";
    if (!decided) return { ...record, changes };
    const items = record.items.map((item) => (item.taskId === entry.taskId ? { ...item, choice: { status: entry.status, at, eventId: entry.eventId, revision: entry.revision ?? entry.expectedRevision } } : item));
    // A tab closed with no choice was flagged for review; the person's explicit choice since answers that flag.
    const flags = record.flags.map((flag) => (flag.kind === "closed" && flag.taskId === entry.taskId && !flag.reviewedAt ? { ...flag, reviewedAt: at } : flag));
    return { ...record, changes, items, flags };
  }

  // --- The inbox (file-bridge fallback) ----------------------------------------------------

  async #readLedger(): Promise<Ledger> {
    try {
      const parsed = ledgerSchema.safeParse(await this.#workspace.readJson(SESSIONS_DIR, INBOX_LEDGER_FILE));
      return parsed.success ? parsed.data : { imports: [] };
    } catch {
      return { imports: [] };
    }
  }

  async #readInboxFile(name: string): Promise<{ readonly bytes: number; readonly text?: string; readonly tooLarge?: boolean } | undefined> {
    if (!INBOX_NAME.test(name)) return undefined;
    let file: string;
    try {
      file = await this.#workspace.resolveReal(INBOX_DIR, name);
      const info = await stat(file);
      if (!info.isFile()) return undefined;
      if (info.size > MAX_BRIDGE_BODY_BYTES) return { bytes: info.size, tooLarge: true };
      return { bytes: info.size, text: await readFile(file, "utf8") };
    } catch {
      return { bytes: 0 };
    }
  }

  /** What one event from `inbox/` would do now, without doing it. */
  async #planInboxEvent(event: z.infer<typeof inboxEventSchema>, commands: CommandQueue): Promise<InboxEventPlan> {
    if (event.type === "job_capture") return { type: "job_capture", eventId: event.eventId, taskIds: [], plan: "not_here" };
    const now = this.#clock.now();
    if (event.type === "browser_command_result") {
      const planned = await this.#planCommandResult(event, { commands, receivedAt: now, source: "inbox" });
      const taskIds = event.items.map((item) => item.taskId);
      if (planned.refused) return { type: event.type, eventId: event.eventId, taskIds, plan: "refused", code: planned.refused.code, status: event.status };
      return { type: event.type, eventId: event.eventId, taskIds, plan: planned.duplicate ? "already" : "apply", status: event.status };
    }
    const found = await this.#sessionFor(event.taskId, event.eventId, undefined);
    const taskIds = [event.taskId];
    if (found.earlier) return { type: event.type, eventId: event.eventId, taskIds, plan: found.earlier.entry.outcome === "refused" ? "refused" : "already", code: found.earlier.entry.outcome === "refused" ? "stale_revision" : undefined, status: event.status };
    if (!found.record) return { type: event.type, eventId: event.eventId, taskIds, plan: "refused", code: "task_not_in_session", status: event.status };
    const decision = decideStatusChange(await new ApplicationsStore(this.#workspace, this.#clock).get(event.taskId), event);
    if (decision.kind === "refused") return { type: event.type, eventId: event.eventId, taskIds, plan: "refused", code: decision.code, status: event.status };
    return { type: event.type, eventId: event.eventId, taskIds, plan: "apply", status: event.status };
  }

  async #describeInboxFile(name: string, commands: CommandQueue, ledger: Ledger): Promise<{ readonly file: InboxFile; readonly events: ReadonlyArray<z.infer<typeof inboxEventSchema>> } | undefined> {
    const read = await this.#readInboxFile(name);
    if (!read) return undefined;
    if (read.tooLarge) return { file: { name, kind: "too_large", bytes: read.bytes, events: [], skipped: 0 }, events: [] };
    if (read.text === undefined) return { file: { name, kind: "unreadable", bytes: read.bytes, events: [], skipped: 0 }, events: [] };
    const sha256 = sha256Hex(read.text);
    const importedAt = ledger.imports.find((entry) => entry.sha256 === sha256)?.importedAt;
    const base = { name, bytes: read.bytes, sha256, ...(importedAt ? { importedAt } : {}) };
    let raw: unknown;
    try {
      raw = JSON.parse(read.text);
    } catch {
      return { file: { ...base, kind: "unreadable", events: [], skipped: 0 }, events: [] };
    }
    const manifest = sessionManifestSchema.safeParse(raw);
    if (manifest.success) {
      // An older (or any) manifest is never state to merge: it names tasks and URLs, never a status.
      const known = (await this.readManifest(manifest.data.sessionId)) !== undefined;
      return { file: { ...base, kind: "session", events: [], skipped: 0, session: { sessionId: manifest.data.sessionId, known, title: manifest.data.title } }, events: [] };
    }
    const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events) ? (raw as { events: unknown[] }).events : [raw];
    const events: Array<z.infer<typeof inboxEventSchema>> = [];
    let skipped = 0;
    for (const entry of entries.slice(0, 500)) {
      const parsed = inboxEventSchema.safeParse(entry);
      if (parsed.success) events.push(parsed.data);
      else skipped += 1;
    }
    skipped += Math.max(0, entries.length - 500);
    if (events.length === 0) return { file: { ...base, kind: "unknown", events: [], skipped }, events: [] };
    const plans: InboxEventPlan[] = [];
    for (const event of events) plans.push(await this.#planInboxEvent(event, commands));
    return { file: { ...base, kind: "events", events: plans, skipped }, events };
  }

  /** Every file in `inbox/` (at most MAX_INBOX_FILES), with what importing it would do now. */
  async inbox(commands: CommandQueue): Promise<{ readonly files: InboxFile[]; readonly more: number }> {
    return this.#serial(async () => {
      const ledger = await this.#readLedger();
      const names = (await this.#workspace.list(INBOX_DIR)).filter((name) => INBOX_NAME.test(name));
      const files: InboxFile[] = [];
      for (const name of names.slice(0, MAX_INBOX_FILES)) {
        const described = await this.#describeInboxFile(name, commands, ledger);
        if (described) files.push(described.file);
      }
      return { files, more: Math.max(0, names.length - MAX_INBOX_FILES) };
    });
  }

  /**
   * Imports one `inbox/` file the person chose: each of its events through the same rules as the bridge, in
   * the file's order, so an event the bridge already delivered, or an older copy, changes nothing. Records the
   * file's outcomes in the ledger. Undefined when there is no such file.
   */
  async importInbox(name: string, commands: CommandQueue): Promise<{ readonly file: InboxFile; readonly outcomes: ReadonlyArray<{ readonly eventId: string; readonly outcome: string }> } | undefined> {
    return this.#serial(async () => {
      const ledger = await this.#readLedger();
      const described = await this.#describeInboxFile(name, commands, ledger);
      if (!described) return undefined;
      const outcomes: Array<{ eventId: string; outcome: string }> = [];
      const receivedAt = this.#clock.now();
      for (const event of described.events) {
        if (event.type === "job_capture") {
          outcomes.push({ eventId: event.eventId, outcome: "not_here" });
          continue;
        }
        const context: ApplyContext = { commands, receivedAt, source: "inbox" };
        const result = event.type === "browser_command_result" ? await this.#applyCommandResult(event, context) : await this.#applyStatusChange(event, context);
        if (result.kind === "refused") {
          // A refused status change is remembered with its eventId, so the file reads as synced and a copy stays refused.
          if (event.type === "application_status_changed") await this.#rememberRefusal(event, receivedAt);
          outcomes.push({ eventId: event.eventId, outcome: `refused:${result.code}` });
        } else {
          outcomes.push({ eventId: event.eventId, outcome: result.kind === "duplicate" ? "already" : "applied" });
        }
      }
      if (described.file.sha256 && described.file.kind === "events") {
        const entry = { name, sha256: described.file.sha256, importedAt: receivedAt.toISOString(), outcomes };
        const next: Ledger = { imports: [...ledger.imports.filter((existing) => existing.sha256 !== entry.sha256), entry].slice(-200) };
        await this.#workspace.writeJson([SESSIONS_DIR, INBOX_LEDGER_FILE], ledgerSchema.parse(next));
      }
      const after = await this.#describeInboxFile(name, commands, await this.#readLedger());
      return { file: after?.file ?? described.file, outcomes };
    });
  }

  async #rememberRefusal(event: ApplicationStatusChanged, receivedAt: Date): Promise<void> {
    const found = await this.#sessionFor(event.taskId, event.eventId, undefined);
    if (found.earlier || !found.record) return;
    const entry: ChangeEntry = { eventId: event.eventId, taskId: event.taskId, status: event.status, expectedRevision: event.expectedRevision, at: receivedAt.toISOString(), source: "inbox", outcome: "refused" };
    await this.#write(this.#withChange(found.record, entry));
  }
}
