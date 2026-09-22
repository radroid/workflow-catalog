import type { EventsRequest } from "@workflow-catalog/contracts";
import { sha256Hex } from "../lib/crypto.ts";
import type { DeviceRecord } from "../store/devices.ts";
import type { DispatchRecord, JournalRecord } from "../store/journal.ts";
import type { RunnerContext } from "./context.ts";
import { EventRejectedError, type EventType, type RegisteredHandler } from "./route-modules.ts";

/**
 * POST /events after the request checks: journal once, dispatch once.
 *
 * 1. The event is journaled under its eventId with an exclusive create
 *    (store/journal.ts), so it is stored once however often it arrives.
 * 2. The handler registered for its `type` runs (server/route-modules.ts);
 *    its outcome is written back to the journal record.
 * 3. A replay of that eventId is answered from the record with
 *    `duplicate: true`, without running the handler again. The exceptions:
 *    a dispatch that failed unexpectedly, or one a crash left pending, runs
 *    again, which is what makes a retry useful.
 *
 * With no handler for the type, the event stays journaled and is
 * acknowledged (202). A later packet's module can pick such events up from
 * `ctx.journal.list({ type, dispatch: "no_handler" })` in its start hook.
 *
 * The same eventId with a different body, or from a different device, is a
 * 409 conflict: an eventId names one event.
 */
export interface EventOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function outcomeFromRecord(record: JournalRecord, duplicate: boolean): EventOutcome {
  const base = { eventId: record.eventId, type: record.type, duplicate };
  const dispatch = record.dispatch;
  switch (dispatch.status) {
    case "no_handler":
      return { status: 202, body: { ok: true, ...base, outcome: "journaled" } };
    case "handled":
      return { status: 200, body: { ok: true, ...base, outcome: "handled", ...(dispatch.result === undefined ? {} : { result: dispatch.result }) } };
    case "rejected":
      return { status: dispatch.httpStatus, body: { ok: false, ...base, error: { code: dispatch.code, message: dispatch.message } } };
    case "failed":
      return {
        status: 500,
        body: {
          ok: false,
          ...base,
          error: { code: "handler_failed", message: "The runner saved this event but could not process it. Send it again to retry." },
        },
      };
    case "pending":
      return { status: 202, body: { ok: true, ...base, outcome: "journaled" } };
  }
}

/** JSON-safe copy of a handler's return value (undefined stays undefined). */
function toJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export class EventsPipeline {
  readonly #ctx: RunnerContext;
  readonly #registry: ReadonlyMap<EventType, RegisteredHandler>;
  /** Per-eventId serialisation inside this process; the exclusive create covers other processes. */
  readonly #inFlight = new Map<string, Promise<EventOutcome>>();

  constructor(ctx: RunnerContext, registry: ReadonlyMap<EventType, RegisteredHandler>) {
    this.#ctx = ctx;
    this.#registry = registry;
  }

  /** The canonical hash of a validated event: zod rebuilt it in schema key order, so whitespace and key order do not matter. */
  static bodyHash(event: EventsRequest): string {
    return sha256Hex(JSON.stringify(event));
  }

  submit(event: EventsRequest, device: DeviceRecord): Promise<EventOutcome> {
    const previous = this.#inFlight.get(event.eventId) ?? Promise.resolve(undefined);
    const run = previous.then(
      () => this.#process(event, device),
      () => this.#process(event, device),
    );
    this.#inFlight.set(event.eventId, run);
    const cleanup = () => {
      if (this.#inFlight.get(event.eventId) === run) this.#inFlight.delete(event.eventId);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  async #process(event: EventsRequest, device: DeviceRecord): Promise<EventOutcome> {
    const ctx = this.#ctx;
    const receivedAt = ctx.clock.now();
    const bodySha256 = EventsPipeline.bodyHash(event);
    const { created, record } = await ctx.journal.append({ event, deviceId: device.deviceId, receivedAt, bodySha256 });
    if (!created) {
      if (record.deviceId !== device.deviceId || record.bodySha256 !== bodySha256) {
        return {
          status: 409,
          body: {
            ok: false,
            eventId: event.eventId,
            error: { code: "event_id_conflict", message: "This eventId was already used for a different event. Use a new eventId for a new event." },
          },
        };
      }
      if (record.dispatch.status !== "failed" && record.dispatch.status !== "pending") return outcomeFromRecord(record, true);
    }
    const handler = this.#registry.get(event.type);
    const at = () => ctx.clock.now().toISOString();
    let dispatch: DispatchRecord;
    if (!handler) {
      dispatch = { status: "no_handler", at: at() };
    } else {
      try {
        const result = toJson(await handler.handle(event, { ...ctx, device, receivedAt }));
        dispatch = { status: "handled", at: at(), handler: handler.module, ...(result === undefined ? {} : { result }) };
      } catch (error) {
        if (error instanceof EventRejectedError) {
          dispatch = { status: "rejected", at: at(), handler: handler.module, httpStatus: error.httpStatus, code: error.code, message: error.message };
        } else {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          ctx.log.error(`The ${handler.module} handler failed on ${event.type} event ${event.eventId}: ${message.slice(0, 200)}`);
          dispatch = { status: "failed", at: at(), handler: handler.module, message: message.slice(0, 500) };
        }
      }
    }
    const next = await ctx.journal.recordDispatch(event.eventId, dispatch);
    return outcomeFromRecord(next, !created);
  }
}
