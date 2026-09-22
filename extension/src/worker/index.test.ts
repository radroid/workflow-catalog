import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** worker/index.ts imports the real, `fetch`-backed `bridgeClient` --
 * mocked here so these tests exercise only the worker's own wiring (does it
 * register the right listeners, does firing the alarm call `flushOutbox`),
 * not the network layer bridge-client.test.ts already covers. */
const postEventMock = vi.fn();
vi.mock("../shared/bridge-client", () => ({
  bridgeClient: { postEvent: (...args: unknown[]) => postEventMock(...args) },
}));

function jobCapture(eventId: string) {
  return {
    protocol: 1 as const,
    type: "job_capture" as const,
    eventId,
    url: "https://jobs.example/postings/1",
    text: "Backend Engineer — Quill, a fictional posting for tests.",
    extractorVersion: "extractor@0.1.0",
    contentHash: "a".repeat(64),
    occurredAt: "2026-09-22T00:00:00.000Z",
  };
}

function installFakeChrome(sessionSeed: Record<string, unknown> = {}): {
  fireAlarm: (name: string) => void;
  alarms: Map<string, { delayInMinutes?: number }>;
} {
  const sessionData: Record<string, unknown> = { ...sessionSeed };
  const alarms = new Map<string, { delayInMinutes?: number }>();
  let alarmListener: ((alarm: { name: string }) => void) | undefined;

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: () => undefined },
    },
    storage: {
      session: {
        async get(keys: string | string[] | null | undefined) {
          // null/undefined both mean "everything" -- shared/outbox.ts's
          // readOutbox() relies on get(null) to enumerate every
          // jobCaptureOutbox:<eventId> key (P07-B revision 1, B2).
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
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => {
          alarmListener = fn;
        },
      },
      create: async (name: string, info: { delayInMinutes?: number }) => {
        alarms.set(name, info);
      },
      get: async (name: string) => alarms.get(name),
      clear: async (name: string) => {
        alarms.delete(name);
      },
    },
    // A deliberately partial stub -- see the same cast note in
    // popup/main.test.ts.
  } as unknown as typeof chrome;

  return {
    fireAlarm: (name: string) => alarmListener?.({ name }),
    alarms,
  };
}

beforeEach(() => {
  vi.resetModules();
  postEventMock.mockReset();
});

afterEach(() => {
  // @ts-expect-error -- test cleanup of a partial chrome stub
  delete globalThis.chrome;
});

describe("worker/index.ts: job_capture outbox retry alarm", () => {
  it("flushes the outbox when the retry alarm fires, and delivers a queued capture", async () => {
    const fake = installFakeChrome({
      "jobCaptureOutbox:11111111-1111-4111-8111-111111111111": {
        capture: jobCapture("11111111-1111-4111-8111-111111111111"),
        attempts: 1,
        queuedAt: "2026-09-22T00:00:00.000Z",
      },
    });
    postEventMock.mockResolvedValue({ ok: true, value: { duplicate: false } });

    await import("./index");
    fake.fireAlarm("job-capture-retry");

    await vi.waitFor(() => {
      expect(postEventMock).toHaveBeenCalledTimes(1);
    });
    expect(postEventMock).toHaveBeenCalledWith(jobCapture("11111111-1111-4111-8111-111111111111"));
  });

  it("ignores an alarm with a different name", async () => {
    const fake = installFakeChrome({
      "jobCaptureOutbox:11111111-1111-4111-8111-111111111111": {
        capture: jobCapture("11111111-1111-4111-8111-111111111111"),
        attempts: 0,
        queuedAt: "2026-09-22T00:00:00.000Z",
      },
    });
    await import("./index");

    fake.fireAlarm("some-other-extensions-alarm");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(postEventMock).not.toHaveBeenCalled();
  });

  it("arms the retry alarm at startup when captures are already queued from a previous session", async () => {
    const fake = installFakeChrome({
      "jobCaptureOutbox:11111111-1111-4111-8111-111111111111": {
        capture: jobCapture("11111111-1111-4111-8111-111111111111"),
        attempts: 0,
        queuedAt: "2026-09-22T00:00:00.000Z",
      },
    });

    await import("./index");

    await vi.waitFor(() => {
      expect(fake.alarms.has("job-capture-retry")).toBe(true);
    });
  });

  it("does not arm any alarm at startup when nothing is queued", async () => {
    const fake = installFakeChrome();
    await import("./index");

    // Nothing to await for a negative assertion -- give any stray async
    // work a couple of microtask/timer ticks, then assert it never happened.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.alarms.size).toBe(0);
  });
});
