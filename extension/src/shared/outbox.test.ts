import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeClient, BridgeError, BridgeResult, PostEventResult } from "./bridge-client";
import { enqueueCapture, ensureRetryAlarmIfQueued, flushOutbox, isQueued, JOB_CAPTURE_RETRY_ALARM, listQueuedCaptures } from "./outbox";

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

function installFakeChrome(): { alarms: Map<string, FakeAlarm>; alarmHistory: FakeAlarm[]; sessionData: Record<string, unknown> } {
  const sessionData: Record<string, unknown> = {};
  const alarms = new Map<string, FakeAlarm>();
  const alarmHistory: FakeAlarm[] = [];
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
        const existed = alarms.has(name);
        alarms.delete(name);
        return existed;
      },
    },
    // A deliberately partial stub -- see the same cast note in
    // popup/main.test.ts.
  } as unknown as typeof chrome;
  return { alarms, alarmHistory, sessionData };
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
 * *while* an earlier entry's postEvent is still in flight. */
function blockingClient(): { client: BridgeClient; resolveNext: () => void } {
  let release: (() => void) | undefined;
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
        release = () => resolve({ ok: true, value: { duplicate: false } });
      }),
  };
  return {
    client,
    resolveNext: () => {
      if (!release) throw new Error("postEvent was never called");
      release();
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
    const { client, resolveNext } = blockingClient();

    const flushPromise = flushOutbox(client);
    // A second, distinct capture arrives (e.g. a Save in the popup) while
    // the first entry's postEvent call above is still unresolved.
    await enqueueCapture(capture("22222222-2222-4222-8222-222222222222"));

    resolveNext();
    const summary = await flushPromise;

    expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
    const remaining = await listQueuedCaptures();
    expect(
      remaining.map((entry) => entry.capture.eventId),
      "the capture enqueued mid-flush must survive -- this is exactly what the old stale write-back lost",
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
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

    it("includePaused: true (E2/B3 'after a new pairing, flush') gives a paused entry a real attempt, and delivers it if that now succeeds", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ status: 401, code: "token_invalid" }));
      const client = fakeClient(() => ({ ok: true, value: { duplicate: false } }));

      const summary = await flushOutbox(client, { includePaused: true });

      expect(summary.delivered).toEqual(["11111111-1111-4111-8111-111111111111"]);
      expect(await listQueuedCaptures()).toEqual([]);
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

    it("a not_paired failure (from a paused entry given a real attempt via includePaused) is re-paused rather than retried forever", async () => {
      await enqueueCapture(capture("11111111-1111-4111-8111-111111111111"), bridgeError({ code: "not_paired" }));
      const client = fakeClient(() => ({ ok: false, error: bridgeError({ code: "not_paired" }) }));

      await flushOutbox(client, { includePaused: true });

      const [entry] = await listQueuedCaptures();
      expect(entry?.pausedReason).toBe("not_paired");
    });
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
