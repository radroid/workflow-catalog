import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeClient, BridgeResult, PostEventResult } from "./bridge-client";
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

function installFakeChrome(): { alarms: Map<string, FakeAlarm>; alarmHistory: FakeAlarm[] } {
  const sessionData: Record<string, unknown> = {};
  const alarms = new Map<string, FakeAlarm>();
  const alarmHistory: FakeAlarm[] = [];
  globalThis.chrome = {
    storage: {
      session: {
        async get(keys: string | string[] | undefined) {
          if (keys === undefined) return { ...sessionData };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in sessionData) out[key] = sessionData[key];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(sessionData, items);
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
  return { alarms, alarmHistory };
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
});
