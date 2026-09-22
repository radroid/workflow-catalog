import { eventsRequestSchema, type EventsRequest } from "@workflow-catalog/contracts";
import { z } from "zod";
import type { Workspace } from "./workspace.ts";

/**
 * The event journal: every event the extension posts to `POST /events`, kept
 * once per `eventId` in `.runner/events/<eventId>.json` before anything acts
 * on it. The file is created with an exclusive create, so a replayed or
 * concurrent duplicate can never produce a second record.
 *
 * A record also keeps what happened when the bridge dispatched the event to
 * its handler (see server/events.ts): a replay answers from this record
 * instead of running the handler again. Only a dispatch that failed
 * unexpectedly (`failed`) is retried on replay.
 *
 * The journal holds captured job text, so it is personal data like the rest
 * of the workspace.
 */
export const dispatchRecordSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("no_handler"), at: z.string() }).strict(),
  z.object({ status: z.literal("handled"), at: z.string(), handler: z.string(), result: z.unknown().optional() }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      at: z.string(),
      handler: z.string(),
      httpStatus: z.number().int(),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
  z.object({ status: z.literal("failed"), at: z.string(), handler: z.string(), message: z.string() }).strict(),
]);
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>;

/**
 * The stored shape. `event` was validated against the contract before it was
 * journaled; reading it back does not re-validate it, so a later, stricter
 * contract can never make an old record unreadable. Consumers that act on a
 * stored event re-validate it with `eventsRequestSchema`.
 */
export const journalRecordSchema = z
  .object({
    eventId: z.uuid(),
    type: z.enum(["job_capture", "browser_command_result", "application_status_changed"]),
    deviceId: z.uuid(),
    receivedAt: z.string(),
    /** sha256 of the validated event as JSON: a replay with a different body under the same eventId is a conflict. */
    bodySha256: z.string(),
    event: z.record(z.string(), z.unknown()),
    dispatch: dispatchRecordSchema,
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type JournalRecord = Omit<z.infer<typeof journalRecordSchema>, "event"> & { readonly event: EventsRequest };

/** Re-validates a stored event against today's contract. */
export function parseJournaledEvent(record: JournalRecord): EventsRequest {
  return eventsRequestSchema.parse(record.event);
}

export interface AppendInput {
  readonly event: EventsRequest;
  readonly deviceId: string;
  readonly receivedAt: Date;
  readonly bodySha256: string;
}

export type AppendResult = { readonly created: true; readonly record: JournalRecord } | { readonly created: false; readonly record: JournalRecord };

export class EventJournal {
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  #segments(eventId: string): string[] {
    return this.#workspace.state("events", `${z.uuid().parse(eventId)}.json`);
  }

  /** Journals an event unless its eventId is already there; then returns the existing record. */
  async append(input: AppendInput): Promise<AppendResult> {
    const record: JournalRecord = {
      eventId: input.event.eventId,
      type: input.event.type,
      deviceId: input.deviceId,
      receivedAt: input.receivedAt.toISOString(),
      bodySha256: input.bodySha256,
      event: input.event,
      dispatch: { status: "pending" },
      attempts: 0,
    };
    const created = await this.#workspace.createJson(this.#segments(record.eventId), record);
    if (created) return { created: true, record };
    const existing = await this.get(record.eventId);
    if (!existing) throw new Error(`Event ${record.eventId} vanished from the journal while being replayed.`);
    return { created: false, record: existing };
  }

  async get(eventId: string): Promise<JournalRecord | undefined> {
    const raw = await this.#workspace.readJson(...this.#segments(eventId));
    return raw === undefined ? undefined : (journalRecordSchema.parse(raw) as JournalRecord);
  }

  /** Records a dispatch outcome and counts the attempt. */
  async recordDispatch(eventId: string, dispatch: DispatchRecord): Promise<JournalRecord> {
    const current = await this.get(eventId);
    if (!current) throw new Error(`Event ${eventId} is not in the journal.`);
    const next: JournalRecord = { ...current, dispatch, attempts: current.attempts + 1 };
    await this.#workspace.writeJson(this.#segments(eventId), next);
    return next;
  }

  /** Every journal record, oldest first. A later packet can use this to process events journaled before its handler existed. */
  async list(filter: { type?: JournalRecord["type"]; dispatch?: DispatchRecord["status"] } = {}): Promise<JournalRecord[]> {
    const records: JournalRecord[] = [];
    for (const name of await this.#workspace.list(...this.#workspace.state("events"))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const record = await this.get(name.slice(0, -".json".length));
      if (!record) continue;
      if (filter.type && record.type !== filter.type) continue;
      if (filter.dispatch && record.dispatch.status !== filter.dispatch) continue;
      records.push(record);
    }
    return records.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
}
