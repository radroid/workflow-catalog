/**
 * What the extension tells the runner about a session (P07 part C): the
 * `browser_command_result` for each opening and closed tab, and the
 * person's explicit `application_status_changed`.
 *
 * - Every event is written to the session record, with its eventId, before
 *   it is sent. A send that fails for a reason that can pass (the runner is
 *   down, another program holds its port) leaves it `pending`; the next
 *   flush sends the same event again, so the runner applies it once
 *   (server/events.ts answers a replay with `duplicate: true`).
 * - A session's events go out in the order they were made. The first
 *   `browser_command_result` names every task in the command; a later one
 *   names only the tabs it is about (P06).
 * - The runner's answer to a report names each application's stage and
 *   revision; that revision is the `expectedRevision` the next choice
 *   names (P06, `Application.revision`, never the job's revision).
 * - A stale revision (409) is never retried blindly: the choice is marked
 *   refused, the side panel says so, and a refresh is a new report whose
 *   answer carries the current revision.
 * - Only `application_status_changed`, sent when the person presses
 *   Applied or Defer, carries a status. A closed tab reports `closed` and
 *   nothing else; nothing a page shows is ever read.
 */
import {
  PROTOCOL_VERSION,
  type ApplicationStatusChanged,
  type BrowserCommandItemStatus,
  type BrowserCommandResult,
  type BrowserCommandResultStatus,
} from "@workflow-catalog/contracts";
import { z } from "zod";
import type { BridgeClient, BridgeError } from "../shared/bridge-client";
import { withLock } from "../shared/locks";
import { getDeviceToken } from "../shared/storage";
import {
  mutateSession,
  listSessions,
  readSession,
  withItem,
  without,
  type ChoiceProblem,
  type ChoiceStatus,
  type EventEntry,
  type LocalSession,
  type SessionEvent,
  type SessionItem,
  type TabMap,
} from "./store";

const revisionSchema = z.number().int().positive();
const commandResultAnswer = z.object({
  items: z.array(z.object({ taskId: z.string(), stage: z.string().max(40), revision: revisionSchema })).max(100),
});
const statusChangeAnswer = z.object({
  taskId: z.string(),
  outcome: z.enum(["applied", "deferred", "already_applied"]),
  stage: z.string().max(40),
  revision: revisionSchema,
});

function nowIso(): string {
  return new Date().toISOString();
}

/** The item as the runner last answered, keeping the newest revision (a
 * replay's answer is the first handling's, which can be older). */
function withAnswer(item: SessionItem, stage: string, revision: number): SessionItem {
  if (item.revision !== undefined && revision < item.revision) return item;
  return { ...item, stage, revision };
}

/** True once a `browser_command_result` for this session is recorded as
 * sent or waiting to be sent: the next one is a later report. */
export function hasFirstReport(session: LocalSession): boolean {
  return session.events.some((entry) => entry.event.type === "browser_command_result" && entry.state !== "refused");
}

/** The first report is the one the runner has to accept before it takes any other (P06: a later report is
 * accepted after expiry only once the first was). */
export function firstReportAccepted(session: LocalSession): boolean {
  const first = session.events.find((entry) => entry.event.type === "browser_command_result");
  return first?.state === "accepted";
}

function overallStatus(statuses: readonly BrowserCommandItemStatus[]): BrowserCommandResultStatus {
  const opened = statuses.filter((status) => status === "opened" || status === "closed").length;
  if (opened === statuses.length) return "completed";
  return opened === 0 ? "failed" : "partial";
}

/**
 * A `browser_command_result` for `session`'s command, naming `items`. The
 * first report must name every task the command carried (P06 flags one it
 * leaves out), so `buildReport` is always handed the whole list then.
 */
export function buildReport(session: LocalSession, items: ReadonlyArray<{ readonly taskId: string; readonly status: BrowserCommandItemStatus }>, statusOverride?: BrowserCommandResultStatus): BrowserCommandResult | undefined {
  if (!session.commandId || items.length === 0) return undefined;
  return {
    protocol: PROTOCOL_VERSION,
    type: "browser_command_result",
    eventId: crypto.randomUUID(),
    commandId: session.commandId,
    status: statusOverride ?? overallStatus(items.map((item) => item.status)),
    items: items.map((item) => ({ taskId: item.taskId, status: item.status })),
    occurredAt: nowIso(),
  };
}

/** The status every item gets in a first report: its tab as recorded, or `skipped` for one never opened. */
export function firstReportItems(session: LocalSession, tabs: TabMap): Array<{ taskId: string; status: BrowserCommandItemStatus }> {
  return session.items.map((item) => {
    if (item.tab === "failed") return { taskId: item.taskId, status: "failed" as const };
    if (item.tab === "closed") return { taskId: item.taskId, status: "closed" as const };
    if (tabs.tabs[item.taskId] !== undefined || item.tab === "opened") return { taskId: item.taskId, status: "opened" as const };
    return { taskId: item.taskId, status: "skipped" as const };
  });
}

/** Appends `event` as pending (a no-op for a bridge-less session). */
export function withQueuedEvent(session: LocalSession, event: SessionEvent | undefined): LocalSession {
  if (!event) return session;
  return { ...session, events: [...session.events, { event, state: "pending", at: nowIso() }] };
}

type SendVerdict =
  | { readonly kind: "accepted"; readonly result: unknown }
  | { readonly kind: "retry"; readonly code: string }
  | { readonly kind: "refused"; readonly code: string; readonly status?: number };

/** What a failed send means for the event: sent again later, or never (the runner refused it for good). */
function verdictFor(error: BridgeError): SendVerdict {
  const retry = { kind: "retry" as const, code: error.code };
  if (error.code === "network_error" || error.code === "invalid_response" || error.code === "unknown_error" || error.code === "token_replaced" || error.code === "not_paired") return retry;
  if (error.status === undefined || error.status >= 500) return retry;
  // A refused token or origin is about the pairing, not this event: it waits for a new one.
  if (error.status === 401 || error.code === "origin_not_allowed" || error.code === "origin_required") return retry;
  return { kind: "refused", code: error.code, status: error.status };
}

async function send(client: BridgeClient, event: SessionEvent): Promise<SendVerdict> {
  const result = await client.postEvent(event);
  if (result.ok) return { kind: "accepted", result: result.value.result };
  return verdictFor(result.error);
}

function choiceProblemFor(code: string): ChoiceProblem {
  if (code === "stale_revision") return "stale_revision";
  if (code === "stage_moved_on") return "stage_moved_on";
  if (code === "task_not_for_device" || code === "task_not_in_session") return "not_for_device";
  return "refused";
}

/** Applies one send's verdict for `eventId` to the session record. */
function withVerdict(session: LocalSession, eventId: string, verdict: SendVerdict): LocalSession {
  const entry = session.events.find((candidate) => candidate.event.eventId === eventId);
  if (!entry || entry.state !== "pending") return session;
  const state: EventEntry["state"] = verdict.kind === "accepted" ? "accepted" : verdict.kind === "refused" ? "refused" : "pending";
  const nextEntry: EventEntry = { ...entry, state, ...(verdict.kind === "accepted" ? {} : { code: verdict.code }) };
  let next: LocalSession = { ...session, events: session.events.map((candidate) => (candidate === entry ? nextEntry : candidate)) };
  const event = entry.event;

  if (event.type === "browser_command_result") {
    if (verdict.kind === "accepted") {
      const answer = commandResultAnswer.safeParse(verdict.result);
      if (answer.success) {
        for (const answered of answer.data.items) next = withItem(next, answered.taskId, (item) => withAnswer(item, answered.stage, answered.revision));
      }
    } else if (verdict.kind === "refused") {
      // The runner refused a report on this command (expired, unknown, another browser's): no later one can pass.
      const problem = verdict.code === "command_expired" ? "expired" : verdict.code === "command_not_for_device" ? "not_for_device" : verdict.code.startsWith("unknown") ? "unknown" : "refused";
      next = { ...next, reportProblem: problem };
    }
    return next;
  }

  // application_status_changed
  if (verdict.kind === "accepted") {
    const answer = statusChangeAnswer.safeParse(verdict.result);
    next = withItem(next, event.taskId, (item) => {
      const answered = answer.success ? withAnswer(item, answer.data.stage, answer.data.revision) : item;
      const outcome = answer.success ? answer.data.outcome : event.status;
      return { ...without(answered, "choiceProblem"), choice: { status: event.status, at: nowIso(), outcome } };
    });
  } else if (verdict.kind === "refused") {
    next = withItem(next, event.taskId, (item) => ({ ...item, choiceProblem: choiceProblemFor(verdict.code) }));
  } else {
    next = withItem(next, event.taskId, (item) => ({ ...item, choiceProblem: verdict.code === "not_paired" || verdict.code === "token_invalid" ? "pairing" : "unreachable" }));
  }
  return next;
}

export interface FlushSummary {
  readonly sent: number;
  readonly pending: number;
  /** The code that stopped the flush, if one did. */
  readonly stoppedOn?: string;
}

function flushLockName(sessionId: string): string {
  return `wc-flush:${sessionId}`;
}

/**
 * Sends `sessionId`'s pending events, oldest first, stopping at the first
 * one that has to wait. Held under the session's flush lock, so two
 * contexts never send the same session's events at once.
 */
export async function flushSession(sessionId: string, client: BridgeClient): Promise<FlushSummary> {
  return withLock(flushLockName(sessionId), async () => {
    let sent = 0;
    for (;;) {
      const session = await readSession(sessionId);
      if (!session || session.source !== "bridge") return { sent, pending: 0 };
      const pending = session.events.filter((entry) => entry.state === "pending");
      const entry = pending[0];
      if (!entry) return { sent, pending: 0 };
      if (session.reportProblem && entry.event.type === "browser_command_result") {
        // A refused first report: nothing later on this command can pass. Mark the rest refused, once.
        await mutateSession(sessionId, (current) =>
          current ? { session: withVerdict(current, entry.event.eventId, { kind: "refused", code: `after_${session.reportProblem}` }) } : undefined,
        );
        continue;
      }
      const verdict = await send(client, entry.event);
      await mutateSession(sessionId, (current) => (current ? { session: withVerdict(current, entry.event.eventId, verdict) } : undefined));
      if (verdict.kind === "retry") return { sent, pending: pending.length, stoppedOn: verdict.code };
      sent += 1;
    }
  });
}

/** Flushes every bridge session with something pending. */
export async function flushAllSessions(client: BridgeClient): Promise<FlushSummary> {
  let sent = 0;
  let pending = 0;
  let stoppedOn: string | undefined;
  for (const session of await listSessions()) {
    if (session.source !== "bridge" || !session.events.some((entry) => entry.state === "pending")) continue;
    const summary = await flushSession(session.sessionId, client);
    sent += summary.sent;
    pending += summary.pending;
    stoppedOn ??= summary.stoppedOn;
  }
  return { sent, pending, ...(stoppedOn ? { stoppedOn } : {}) };
}

export type ChoiceOutcome =
  | { readonly kind: "recorded"; readonly outcome: "applied" | "deferred" | "already_applied" }
  | { readonly kind: "local" }
  | { readonly kind: "no_revision" }
  | { readonly kind: "not_paired" }
  | { readonly kind: "other_pairing" }
  | { readonly kind: "report_problem"; readonly problem: NonNullable<LocalSession["reportProblem"]> }
  | { readonly kind: "problem"; readonly problem: ChoiceProblem }
  | { readonly kind: "gone" };

/**
 * The person pressed Applied or Defer for `taskId`. The one path that
 * sends a status. A session from a file records the choice here only: the
 * runner can't take it from the browser (its manifest carries no
 * application revision, and the runner took it for no device), so the side
 * panel asks the person to confirm it on the runner's Board.
 */
export async function chooseStatus(sessionId: string, taskId: string, status: ChoiceStatus, client: BridgeClient): Promise<ChoiceOutcome> {
  const session = await readSession(sessionId);
  const item = session?.items.find((candidate) => candidate.taskId === taskId);
  if (!session || !item) return { kind: "gone" };

  if (session.source === "file") {
    await mutateSession(sessionId, (current) =>
      current ? { session: withItem(current, taskId, (entry) => ({ ...without(entry, "choiceProblem"), choice: { status, at: nowIso(), outcome: "local" } })) } : undefined,
    );
    return { kind: "local" };
  }
  if (session.reportProblem) return { kind: "report_problem", problem: session.reportProblem };
  if (item.revision === undefined) return { kind: "no_revision" };
  const token = await getDeviceToken();
  if (!token) return { kind: "not_paired" };
  if (session.deviceId !== undefined && token.deviceId !== session.deviceId) return { kind: "other_pairing" };

  let eventId = "";
  await mutateSession(sessionId, (current) => {
    if (!current) return undefined;
    const currentItem = current.items.find((candidate) => candidate.taskId === taskId);
    if (!currentItem || currentItem.revision === undefined) return undefined;
    // A choice sent before and not answered yet is sent again as the same event; a different choice
    // replaces it (the older one is dropped here, and the runner refuses it as stale if it ever lands).
    const earlier = current.events.find(
      (entry) => entry.state === "pending" && entry.event.type === "application_status_changed" && entry.event.taskId === taskId,
    );
    if (earlier && earlier.event.type === "application_status_changed" && earlier.event.status === status) {
      eventId = earlier.event.eventId;
      return { session: withItem(current, taskId, (entry) => without(entry, "choiceProblem")) };
    }
    const event: ApplicationStatusChanged = {
      protocol: PROTOCOL_VERSION,
      type: "application_status_changed",
      eventId: crypto.randomUUID(),
      taskId,
      expectedRevision: currentItem.revision,
      status,
      occurredAt: nowIso(),
    };
    eventId = event.eventId;
    const withoutEarlier = earlier
      ? { ...current, events: current.events.map((entry) => (entry === earlier ? { ...entry, state: "refused" as const, code: "replaced" } : entry)) }
      : current;
    return { session: withItem(withQueuedEvent(withoutEarlier, event), taskId, (entry) => without(entry, "choiceProblem")) };
  });
  if (eventId === "") return { kind: "no_revision" };

  const summary = await flushSession(sessionId, client);
  const after = await readSession(sessionId);
  const entry = after?.events.find((candidate) => candidate.event.eventId === eventId);
  const afterItem = after?.items.find((candidate) => candidate.taskId === taskId);
  if (entry?.state === "accepted" && afterItem?.choice && afterItem.choice.outcome !== "local") return { kind: "recorded", outcome: afterItem.choice.outcome };
  if (entry?.state === "refused") return { kind: "problem", problem: afterItem?.choiceProblem ?? "refused" };
  if (after?.reportProblem) return { kind: "report_problem", problem: after.reportProblem };
  return { kind: "problem", problem: summary.stoppedOn === "not_paired" || summary.stoppedOn === "token_invalid" ? "pairing" : (afterItem?.choiceProblem ?? "unreachable") };
}

export type RefreshOutcome = { readonly kind: "refreshed" } | { readonly kind: "not_possible" } | { readonly kind: "waiting"; readonly code?: string };

/**
 * After a stale refusal: asks the runner for the current revisions with a
 * new, later `browser_command_result` naming `taskIds` with their tabs as
 * this browser knows them (P06: a later report's answer is current; a
 * replayed one's is not). Only the person starts this; nothing retries a
 * refused choice.
 */
export async function refreshRevisions(sessionId: string, taskIds: readonly string[], client: BridgeClient): Promise<RefreshOutcome> {
  let queued = false;
  await mutateSession(sessionId, (session, tabs) => {
    if (!session || session.source !== "bridge" || session.reportProblem || !firstReportAccepted(session)) return undefined;
    const items = session.items
      .filter((item) => taskIds.includes(item.taskId))
      .map((item) => ({ taskId: item.taskId, status: (tabs.tabs[item.taskId] !== undefined ? "opened" : "closed") as BrowserCommandItemStatus }));
    const report = buildReport(session, items, "completed");
    if (!report) return undefined;
    queued = true;
    const cleared = session.items.reduce((acc, item) => (taskIds.includes(item.taskId) ? withItem(acc, item.taskId, (entry) => without(entry, "choiceProblem")) : acc), session);
    return { session: withQueuedEvent(cleared, report) };
  });
  if (!queued) return { kind: "not_possible" };
  const summary = await flushSession(sessionId, client);
  if (summary.stoppedOn) return { kind: "waiting", code: summary.stoppedOn };
  return { kind: "refreshed" };
}
