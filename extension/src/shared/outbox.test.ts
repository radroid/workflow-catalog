import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeClient, type BridgeClient, type BridgeError, type BridgeResult, type PostEventResult } from "./bridge-client";
import { getDeviceToken, getPairingExpired, recordPairing } from "./storage";
import {
  enqueueCapture,
  ensureRetryAlarmIfQueued,
  failureAction,
  flushOutbox,
  isQueued,
  JOB_CAPTURE_RETRY_ALARM,
  listQueuedCaptures,
  outboxUsedThisSession,
  resumeAfterPairing,
} from "./outbox";

function capture(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1 as const,
    type: "job_capture" as const,
    eventId,
    url: "https://jobs.example/postings/1",
    text: "Backend Engineer — Quill, a fictional posting for tests.",
    extractorVersion: "extractor@0.1.0",
    contentHash: "a".repeat(64),
    occurredAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeAlarm {
  name: string;
  delayInMinutes?: number;
}

interface FakeChromeHandle {
  alarms: Map<string, FakeAlarm>;
  alarmHistory: FakeAlarm[];
  sessionData: Record<string, unknown>;
  /** Runs inside `chrome.alarms.clear`, before the alarm is removed -- lets
   * a test put another context's work exactly between a flush's decision
   * to clear the alarm and the clear itself. */
  beforeAlarmClear?: () => Promise<void>;
}

function installFakeChrome(): FakeChromeHandle {
  const sessionData: Record<string, unknown> = {};
  const alarms = new Map<string, FakeAlarm>();
  const alarmHistory: FakeAlarm[] = [];
  const handle: FakeChromeHandle = { alarms, alarmHistory, sessionData };
  globalThis.chrome = {
    storage: {
      session: {
        async get(keys: string | string[] | null | undefined) {
          // null (and omitting the argument) both mean "everything" in the
          // real chrome.storage API -- outbox.ts's readOutbox() relies on
          // get(null) to enumerate every jobCaptureOutbox:<eventId> key
          // without keeping a separate index to race on (P07-B revision 1,
          // B2).
          if (keys === undefined || keys === null) return { ...sessionData };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in sessionData) out[key] = sessionData[key];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(sessionData, items);
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionData[key];
        },
      },
    },
    alarms: {
      async create(name: string, info: { delayInMinutes?: number }) {
        const alarm = { name, delayInMinutes: info.delayInMinutes };
        alarms.set(name, alarm);
        alarmHistory.push(alarm);
      },
      async get(name: string) {
        return alarms.get(name);
      },
      async clear(name: string) {
        const hook = handle.beforeAlarmClear;
        handle.beforeAlarmClear = undefined;
        if (hook) await hook();
        const existed = alarms.has(name);
        alarms.delete(name);
        return existed;
      },
    },
    // A deliberately partial stub -- see the same cast note in
    // popup/main.test.ts.
  } as unknown as typeof chrome;
  return handle;
}

afterEach(() => {
  // @ts-expect-error -- test cleanup of a partial chrome stub
  delete globalThis.chrome;
});

function fakeClient(handler: (event: unknown) => BridgeResult<PostEventResult>): BridgeClient {
  return {
    pair: () => {
      throw new Error("not used in these tests");
    },
    getCommands: () => {
      throw new Error("not used in these tests");
    },
    getStatus: () => {
      throw new Error("not used in these tests");
    },
    postEvent: (event) => Promise.resolve(handler(event)),
  };
}

/** A postEvent that hangs until the test explicitly lets it continue --
 * for proving B2's race fix, where the exact bug was in what happens
 * *while* an earlier entry's postEvent is still in flight. `resolveNext`
 * answers the pending call with success, or with `result` when given;
 * `called` resolves once postEvent has been called. */
function blockingClient(): {
  client: BridgeClient;
  resolveNext: (result?: BridgeResult<PostEventResult>) => void;
  called: Promise<void>;
} {
  let release: ((result: BridgeResult<PostEventResult>) => void) | undefined;
  let markCalled: () => void = () => undefined;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const client: BridgeClient = {
    pair: () => {
      throw new Error("not used in these tests");
    },
    getCommands: () => {
      throw new Error("not used in these tests");
    },
    getStatus: () => {
      throw new Error("not used in these tests");
    },
    postEvent: () =>
      new Promise((resolve) => {
        release = resolve;
        markCalled();
      }),
  };
  return {
    client,
    called,
    resolveNext: (result = { ok: true, value: { duplicate: false } }) => {
      if (!release) throw new Error("postEvent was never called");
      release(result);
    },
  };
}

function bridgeError(overrides: Partial<BridgeError>): BridgeError {
  return { code: "network_error", message: "down", ...overrides };
}

describe("enqueueCapture", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it("queues a capture and arms the retry alarm", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    expect(await isQueued("11111111-1111-4111-8111-111111111111")).toBe(true);
    const alarm = fake.alarms.get(JOB_CAPTURE_RETRY_ALARM);
    expect(alarm).toBeDefined();
    expect(alarm?.delayInMinutes).toBeGreaterThan(0);
  });

  it("is idempotent by eventId -- enqueueing the same capture twice keeps one entry", async () => {
    const event = capture("11111111-1111-4111-8111-111111111111");
    await enqueueCapture(event);
    await enqueueCapture(event);
    const entries = await listQueuedCaptures();
    expect(entries).toHaveLength(1);
  });

  it("keeps distinct captures separate", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));
    const entries = await listQueuedCaptures();
    expect(entries.map((entry) => entry.capture.eventId).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("P07-B revision 1, E2: a not_paired failure is queued too (paused, no alarm armed), not skipped the way part A's design skipped it", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ code: "not_paired" }));

    expect(await isQueued("11111111-1111-4111-8111-111111111111")).toBe(true);
    const [entry] = await listQueuedCaptures();
    expect(entry?.pausedReason).toBe("not_paired");
    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
  });

  it("a 401/403 initialError queues the capture already paused, without arming an alarm for it", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 403, code: "origin_not_allowed" }));

    const [entry] = await listQueuedCaptures();
    expect(entry?.pausedReason).toBe("origin_not_allowed");
    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
  });
});

describe("flushOutbox", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it("delivers a queued capture and removes it, clearing the alarm once the queue is empty", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const client = fakeClient(() => ({ ok: true, value: { duplicate: false } }));

    const summary = await flushOutbox(client);

    expect(summary).toEqual({ delivered: ["11111111-1111-4111-8111-111111111111"], stillPending: 0 });
    expect(await listQueuedCaptures()).toEqual([]);
    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
  });

  it("treats duplicate:true the same as a fresh success (gate 1: a replay still counts as delivered)", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const client = fakeClient(() => ({ ok: true, value: { duplicate: true } }));

    const summary = await flushOutbox(client);

    expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(await listQueuedCaptures()).toEqual([]);
  });

  it("leaves a still-failing capture queued, bumps its attempt count, and reschedules with backoff", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const client = fakeClient(() => ({ ok: false, error: { code: "network_error", message: "down" } }));

    await flushOutbox(client);
    const afterFirst = await listQueuedCaptures();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.attempts).toBe(1);
    const firstDelay = fake.alarms.get(JOB_CAPTURE_RETRY_ALARM)?.delayInMinutes;

    await flushOutbox(client);
    const afterSecond = await listQueuedCaptures();
    expect(afterSecond[0]?.attempts).toBe(2);
    const secondDelay = fake.alarms.get(JOB_CAPTURE_RETRY_ALARM)?.delayInMinutes;

    expect(firstDelay).toBeGreaterThan(0);
    expect(secondDelay).toBeGreaterThan(firstDelay ?? 0);
  });

  it("delivers each queued capture independently -- one success and one still-failing entry in the same pass", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));
    const client = fakeClient((event) => {
      const id = (event as { eventId: string }).eventId;
      return id === "11111111-1111-4111-8111-111111111111"
        ? { ok: true, value: { duplicate: false } }
        : { ok: false, error: { code: "network_error", message: "down" } };
    });

    const summary = await flushOutbox(client);

    expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(summary.stillPending).toBe(1);
    const remaining = await listQueuedCaptures();
    expect(remaining.map((entry) => entry.capture.eventId)).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("does nothing (and touches no alarm) when the queue is already empty", async () => {
    const client = fakeClient(() => {
      throw new Error("postEvent must not be called for an empty queue");
    });
    const summary = await flushOutbox(client);
    expect(summary).toEqual({ delivered: [], stillPending: 0 });
    expect(fake.alarmHistory).toEqual([]);
  });

  it("P07-B revision 1, B2: a capture enqueued by a different JS context while an earlier entry's postEvent is still in flight is never lost", async () => {
    // This is the exact race the old single-array design lost: flushOutbox
    // reads the whole list once, awaits postEvent (real network time) for
    // the first entry, then used to write back its own -- by then stale --
    // idea of "what's left". A second capture enqueued by e.g. a popup
    // while that await is still pending (a genuinely different JS context
    // from the worker's alarm-driven flush; see this file's header) used
    // to be silently wiped out by that stale write-back. Per-key storage
    // makes this impossible: each entry's delivery/removal only ever
    // touches its own key.
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const { client, resolveNext, called } = blockingClient();

    const flushPromise = flushOutbox(client);
    await called;
    // A second, distinct capture arrives (e.g. a Save in the popup) while
    // the first entry's postEvent call above is still unresolved.
    await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));

    resolveNext();
    const summary = await flushPromise;

    expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(summary.stillPending, "stillPending comes from a fresh read, so it counts the capture queued mid-flush").toBe(1);
    const remaining = await listQueuedCaptures();
    expect(
      remaining.map((entry) => entry.capture.eventId),
      "the capture enqueued mid-flush must survive -- this is exactly what the old stale write-back lost",
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
    // P07-B revision 2, B1: and it keeps its retry alarm. Revision 1's
    // flush cleared the alarm because its own pass had nothing left to
    // retry, wiping the alarm the enqueue above had just armed.
    expect(
      fake.alarms.has(JOB_CAPTURE_RETRY_ALARM),
      "the capture queued mid-flush must still have a retry alarm once the flush finishes",
    ).toBe(true);
  });

  it("P07-B revision 2, B1: a capture queued between the flush's final read and its alarm clear gets its alarm back", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const client = fakeClient(() => ({ ok: true, value: { duplicate: false } }));
    // The flush delivers 1111, reads an empty queue and decides to clear
    // the alarm. Before the clear lands, another context queues 2222 --
    // entry written, alarm armed -- and the clear then removes that alarm.
    fake.beforeAlarmClear = () => enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));

    const summary = await flushOutbox(client);

    expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(summary.stillPending).toBe(1);
    expect(fake.beforeAlarmClear, "the flush did reach its alarm clear").toBeUndefined();
    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM), "the re-read after the clear must re-arm the alarm for 2222").toBe(true);
  });

  it("P07-B revision 2, B1: a flush that finds only paused entries left clears the alarm", async () => {
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ code: "not_paired" }));
    await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));
    const client = fakeClient(() => ({ ok: true, value: { duplicate: false } }));

    const summary = await flushOutbox(client);

    expect(summary).toEqual({ delivered: ["22222222-2222-4222-8222-222222222222"], stillPending: 1 });
    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
  });

  it("P07-B revision 2, nit: captures queued in the same millisecond flush in one fixed order -- by occurredAt, then eventId", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T10:00:00.000Z"));
    try {
      // Queued in the "wrong" order on purpose: storage.session.get(null)
      // makes no ordering promise, and the fake returns insertion order.
      await enqueueCapture(capture("44444444-4444-4444-8444-444444444444", { occurredAt: "2026-09-22T09:59:59.000Z" }));
      await enqueueCapture(capture("22222222-2222-4222-8222-222222222222", { occurredAt: "2026-09-22T09:00:00.000Z" }));
      await enqueueCapture(capture("33333333-3333-4333-8333-333333333333", { occurredAt: "2026-09-22T09:59:59.000Z" }));
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111", { occurredAt: "2026-09-22T09:59:59.000Z" }));
    } finally {
      vi.useRealTimers();
    }
    const order: string[] = [];
    const client = fakeClient((event) => {
      order.push((event as { eventId: string }).eventId);
      return { ok: true, value: { duplicate: false } };
    });

    const queuedAt = new Set((await listQueuedCaptures()).map((entry) => entry.queuedAt));
    expect(queuedAt.size, "all four share one queuedAt").toBe(1);
    await flushOutbox(client);

    expect(order).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  describe("P07-B revision 1, B3: branching on status/code instead of one blanket message", () => {
    it("a network error or 5xx keeps the capture queued, actively retried", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ code: "network_error" }) }));

      const summary = await flushOutbox(client);

      expect(summary.stillPending).toBe(1);
      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBeUndefined();
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
    });

    it("a 500 from a route handler keeps the capture queued, actively retried, the same as a network error", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ status: 500, code: "handler_failed" }) }));

      await flushOutbox(client);

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBeUndefined();
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
    });

    it("a 401 pauses the capture (still queued, but no longer actively retried) and clears the alarm once nothing else is active", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ status: 401, code: "token_invalid" }) }));

      const summary = await flushOutbox(client);

      expect(summary.stillPending).toBe(1);
      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBe("token_invalid");
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
    });

    it("a 403 pauses the capture the same way a 401 does", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ status: 403, code: "origin_not_allowed" }) }));

      await flushOutbox(client);

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBe("origin_not_allowed");
    });

    it("a paused entry is skipped (postEvent not called again for it) on an ordinary flush", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 401, code: "token_invalid" }));
      let calls = 0;
      const client = fakeClient(() => {
        calls += 1;
        return { ok: true, value: { duplicate: false } };
      });

      const summary = await flushOutbox(client);

      expect(calls).toBe(0);
      expect(summary).toEqual({ delivered: [], stillPending: 1 });
    });

    it("resumeAfterPairing (E2/B3 'after a new pairing, flush') gives a paused entry a real attempt, and delivers it if that now succeeds", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 401, code: "token_invalid" }));
      const client = fakeClient(() => ({ ok: true, value: { duplicate: false } }));

      const summary = await resumeAfterPairing(client);

      expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
      expect(await listQueuedCaptures()).toEqual([]);
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM), "nothing left to retry").toBe(false);
    });

    it("any other 4xx (400, 409, 413, 422) drops the capture instead of queueing it forever", async () => {
      for (const status of [400, 409, 413, 422]) {
        const eventId = `3333333${status}-3333-4333-8333-333333333333`.slice(0, 36);
        await enqueueCapture(capture(eventId));
        const client = fakeClient(() => ({ ok: false, error: bridgeError({ status, code: "some_4xx" }) }));

        const summary = await flushOutbox(client);

        expect(summary.delivered, `status ${status}`).toEqual([]);
        expect(await isQueued(eventId), `status ${status} should not stay queued`).toBe(false);
      }
    });

    it("a not_paired failure (from a paused entry given a real attempt by resumeAfterPairing) is re-paused rather than retried forever", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ code: "not_paired" }));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ code: "not_paired" }) }));

      await resumeAfterPairing(client);

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBe("not_paired");
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
    });
  });

  describe("P07-B revision 2, B3: a capture no bridge received is never deleted", () => {
    // Probes P3/P4 of the round-2 review: another program on 4310 answered
    // `200 text/html`, and revision 1's drop branch deleted the capture.
    for (const error of [
      bridgeError({ code: "invalid_response", message: "The runner's events response didn't match the expected shape." }),
      bridgeError({ status: 404, code: "unknown_error", message: "The runner answered with an unexpected error (HTTP 404)." }),
      bridgeError({ status: 401, code: "unknown_error", message: "The runner answered with an unexpected error (HTTP 401)." }),
      bridgeError({ status: 403, code: "unknown_error", message: "The runner answered with an unexpected error (HTTP 403)." }),
    ]) {
      it(`${error.code}${error.status ? ` (HTTP ${error.status})` : ""} keeps the capture queued, active, with the error recorded, and re-arms the alarm`, async () => {
        await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
        const client = fakeClient(() => ({ ok: false, error }));

        const summary = await flushOutbox(client);

        expect(summary).toEqual({ delivered: [], stillPending: 1 });
        const [entry] = await listQueuedCaptures();
        expect(entry?.capture.eventId).toBe("11111111-1111-4111-8111-111111111111");
        expect(entry?.attempts).toBe(1);
        expect(entry?.pausedReason, "not a pause: nothing says this browser's pairing is wrong").toBeUndefined();
        expect(entry?.lastErrorCode).toBe(error.code);
        expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
      });
    }
  });

  describe("P07-B revision 2, B2: a pause never outlives the pairing that lifted it", () => {
    it("resumeAfterPairing lifts every pause in storage and arms the alarm before its first request, so closing the page mid-flush loses nothing", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ code: "not_paired" }));
      await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"), bridgeError({ status: 401, code: "token_invalid" }));
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
      const { client, called } = blockingClient();

      // Never resolved: the options page closes while the first request is
      // in flight. Whatever is in storage now is all the worker will see.
      void resumeAfterPairing(client);
      await called;

      const entries = await listQueuedCaptures();
      expect(entries.map((entry) => entry.pausedReason)).toEqual([undefined, undefined]);
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM), "the worker's alarm must already be armed").toBe(true);
      // ...and the worker's next alarm flush sends both.
      const sent: string[] = [];
      await flushOutbox(fakeClient((event) => {
        sent.push((event as { eventId: string }).eventId);
        return { ok: true, value: { duplicate: false } };
      }));
      expect(sent).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    });

    it("probe P2: a paused entry whose first attempt after re-pairing gets a 503 stays active, and later alarm flushes send it", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 401, code: "token_invalid" }));

      await resumeAfterPairing(fakeClient(() => ({ ok: false, error: bridgeError({ status: 503, code: "handler_failed" }) })));

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBeUndefined();
      expect(entry?.attempts).toBe(1);
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
      const summary = await flushOutbox(fakeClient(() => ({ ok: true, value: { duplicate: false } })));
      expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    });

    it("the retry branch clears pausedReason: an entry paused by another context while this flush's request was in flight comes back active after a retryable failure", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const { client, resolveNext, called } = blockingClient();

      const flushPromise = flushOutbox(client);
      await called;
      const key = "jobCaptureOutbox:11111111-1111-4111-8111-111111111111";
      fake.sessionData[key] = { ...(fake.sessionData[key] as object), pausedReason: "token_invalid" };
      resolveNext({ ok: false, error: bridgeError({ status: 503, code: "handler_failed" }) });
      await flushPromise;

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason, "revision 1 carried the pause forward here").toBeUndefined();
      expect(entry?.lastErrorCode).toBe("handler_failed");
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
    });

    it("a failure is never written back over a capture another context delivered while this flush's request was in flight", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
      const { client, resolveNext, called } = blockingClient();

      const flushPromise = flushOutbox(client);
      await called;
      // The options page's post-pairing flush delivered it meanwhile.
      delete fake.sessionData["jobCaptureOutbox:11111111-1111-4111-8111-111111111111"];
      resolveNext({ ok: false, error: bridgeError({ code: "network_error" }) });
      const summary = await flushPromise;

      expect(summary.stillPending).toBe(0);
      expect(await listQueuedCaptures(), "a stale write-back would resurrect the delivered capture").toEqual([]);
      expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(false);
    });
  });
});

describe("P07-B revision 2, B4 (probe P5): a worker flush racing a pairing, with the real client and storage", () => {
  const EVENT_ID = "11111111-1111-4111-8111-111111111111";

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("the old token's stale 401 neither undoes the new pairing nor writes the delivered capture back as paused", async () => {
    installFakeChrome();
    await recordPairing({ deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "token-one", pairedAt: "2026-09-22T09:00:00.000Z" });
    await enqueueCapture(capture(EVENT_ID), bridgeError({ code: "network_error" }));
    const client = createBridgeClient();
    const seen: Array<string | undefined> = [];
    let journaled = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      seen.push(auth);
      if (auth === "Bearer token-one") {
        // While the worker's request is in flight, the options page pairs
        // again and its own flush delivers the capture with the new token.
        await recordPairing({ deviceId: "9c1d7a1f-3a2b-4d66-8e4f-1b2c3d4e5f60", token: "token-two", pairedAt: "2026-09-22T09:05:00.000Z" });
        await resumeAfterPairing(client);
        return jsonResponse(401, { ok: false, error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." } });
      }
      const duplicate = journaled;
      journaled = true;
      return jsonResponse(200, { ok: true, eventId: EVENT_ID, type: "job_capture", duplicate, outcome: "journaled" });
    }) as typeof fetch;

    const summary = await flushOutbox(client);

    expect(seen, "the worker's request, the pairing's flush, then the worker's one retry with the new token").toEqual([
      "Bearer token-one",
      "Bearer token-two",
      "Bearer token-two",
    ]);
    expect(summary.delivered).toEqual([EVENT_ID]);
    expect((await getDeviceToken())?.token, "revision 1 cleared the new token here").toBe("token-two");
    expect(await getPairingExpired()).toBe(false);
    expect(await listQueuedCaptures(), "revision 1 wrote the capture back as paused").toEqual([]);
  });
});

describe("failureAction (one classification for the popup's Save and the retry flush)", () => {
  const cases: Array<[BridgeError, "pause" | "retry" | "drop"]> = [
    [bridgeError({ code: "not_paired" }), "pause"],
    [bridgeError({ status: 401, code: "token_invalid" }), "pause"],
    [bridgeError({ status: 401, code: "token_missing" }), "pause"],
    [bridgeError({ status: 403, code: "origin_not_allowed" }), "pause"],
    [bridgeError({ code: "network_error" }), "retry"],
    [bridgeError({ status: 500, code: "internal_error" }), "retry"],
    [bridgeError({ status: 503, code: "handler_failed" }), "retry"],
    [bridgeError({ code: "invalid_response" }), "retry"],
    [bridgeError({ status: 404, code: "unknown_error" }), "retry"],
    [bridgeError({ status: 401, code: "unknown_error" }), "retry"],
    [bridgeError({ code: "token_replaced" }), "retry"],
    [bridgeError({ status: 400, code: "invalid_body" }), "drop"],
    [bridgeError({ status: 409, code: "event_id_conflict" }), "drop"],
    [bridgeError({ status: 413, code: "body_too_large" }), "drop"],
    [bridgeError({ status: 415, code: "unsupported_media_type" }), "drop"],
  ];
  for (const [error, expected] of cases) {
    it(`${error.status ?? "no status"} ${error.code} -> ${expected}`, () => {
      expect(failureAction(error)).toBe(expected);
    });
  }
});

describe("outboxUsedThisSession (P07-B revision 2 polish: no 'All saved jobs sent.' on a fresh install)", () => {
  it("is false until something is queued, then stays true after the queue empties", async () => {
    installFakeChrome();
    expect(await outboxUsedThisSession()).toBe(false);
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    await flushOutbox(fakeClient(() => ({ ok: true, value: { duplicate: false } })));
    expect(await listQueuedCaptures()).toEqual([]);
    expect(await outboxUsedThisSession()).toBe(true);
  });
});

describe("ensureRetryAlarmIfQueued", () => {
  it("arms the alarm when captures are queued but no alarm exists (e.g. after a worker/browser restart)", async () => {
    const fake = installFakeChrome();
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    await fake.alarms.get(JOB_CAPTURE_RETRY_ALARM)!;
    // Simulate a restart wiping the in-memory alarm (storage.session's
    // outbox entry survives a worker restart; a scheduled alarm's identity
    // does not need to -- this proves the recreation path independent of
    // Chrome's own alarm persistence).
    fake.alarms.delete(JOB_CAPTURE_RETRY_ALARM);

    await ensureRetryAlarmIfQueued();

    expect(fake.alarms.has(JOB_CAPTURE_RETRY_ALARM)).toBe(true);
  });

  it("does nothing when the queue is empty", async () => {
    const fake = installFakeChrome();
    await ensureRetryAlarmIfQueued();
    expect(fake.alarmHistory).toEqual([]);
  });

  it("leaves an existing alarm alone when one is already scheduled", async () => {
    const fake = installFakeChrome();
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"));
    const createdCount = fake.alarmHistory.length;

    await ensureRetryAlarmIfQueued();

    expect(fake.alarmHistory).toHaveLength(createdCount);
  });

  it("does nothing when every queued entry is paused -- an ordinary flush would skip them all anyway", async () => {
    const fake = installFakeChrome();
    await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 401, code: "token_invalid" }));

    await ensureRetryAlarmIfQueued();

    expect(fake.alarmHistory).toEqual([]);
  });
});
