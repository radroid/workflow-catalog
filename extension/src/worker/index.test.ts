import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** worker/index.ts imports the real, `fetch`-backed `bridgeClient` --
 * mocked here so these tests exercise only the worker's own wiring (does it
 * register the right listeners, does firing the alarm call `flushOutbox`),
 * not the network layer bridge-client.test.ts already covers. */
const postEventMock = vi.fn();
const getCommandsMock = vi.fn();
vi.mock("../shared/bridge-client", () => ({
  bridgeClient: {
    postEvent: (...args: unknown[]) => postEventMock(...args),
    getCommands: (...args: unknown[]) => getCommandsMock(...args),
  },
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
  alarms: Map<string, { delayInMinutes?: number; periodInMinutes?: number }>;
  removeTab: (tabId: number) => void;
  tabsCreated: () => number;
} {
  const sessionData: Record<string, unknown> = { ...sessionSeed };
  const localData: Record<string, unknown> = {};
  const alarms = new Map<string, { delayInMinutes?: number; periodInMinutes?: number }>();
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let removedListener: ((tabId: number) => void) | undefined;
  let created = 0;
  // P07 part C: the session code keeps its records in storage.local, the same shape as storage.session here.
  const area = (data: Record<string, unknown>) => ({
    async get(keys: string | string[] | null | undefined) {
      if (keys === undefined || keys === null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  });

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
      local: area(localData),
    },
    // P07 part C: the worker listens for recorded session tabs closing or being swapped. It never opens one;
    // `create` counts, so a test can prove an alarm opened nothing.
    tabs: {
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => {
          removedListener = fn;
        },
      },
      onReplaced: { addListener: () => undefined },
      create: async () => {
        created += 1;
        return { id: 1 };
      },
      group: async () => 1,
    },
    alarms: {
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => {
          alarmListener = fn;
        },
      },
      create: async (name: string, info: { delayInMinutes?: number; periodInMinutes?: number }) => {
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
    removeTab: (tabId: number) => removedListener?.(tabId),
    tabsCreated: () => created,
  };
}

beforeEach(() => {
  vi.resetModules();
  postEventMock.mockReset();
  getCommandsMock.mockReset();
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

  it("does not arm the retry alarm at startup when nothing is queued", async () => {
    const fake = installFakeChrome();
    await import("./index");

    // Nothing to await for a negative assertion -- give any stray async
    // work a couple of microtask/timer ticks, then assert it never happened.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // P07 part C: the session poll alarm is always armed now (below), so this checks the retry alarm only.
    expect(fake.alarms.has("job-capture-retry")).toBe(false);
  });
});

describe("worker/index.ts: sessions (P07 part C)", () => {
  const DEVICE_ID = "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f";
  const pairing = { deviceToken: { deviceId: DEVICE_ID, token: "fictional-token", pairedAt: "2026-09-25T09:00:00.000Z" } };
  const openCommand = () => ({
    protocol: 1,
    type: "open_application_group",
    commandId: "0d2e8b20-4b3c-4e77-9f50-2c3d4e5f6071",
    deviceId: DEVICE_ID,
    sessionId: "5b6f1c2e-8d4a-4f3b-9c1d-2e3f4a5b6c7d",
    workflowVersion: "job-assistant@0",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    payload: { title: "Apply today", items: [{ taskId: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", jobRevision: 1, url: "https://jobs.example/postings/fictional-1" }] },
  });

  it("arms the 15-minute session poll alarm at every start (recreated, never assumed)", async () => {
    const fake = installFakeChrome();
    await import("./index");
    await vi.waitFor(() => {
      expect(fake.alarms.get("session-poll")).toEqual({ delayInMinutes: 15, periodInMinutes: 15 });
    });
  });

  it("F9/gate 4: the poll alarm takes a waiting session in and opens no tab (only a click in the side panel does)", async () => {
    const fake = installFakeChrome(pairing);
    getCommandsMock.mockResolvedValue({ ok: true, value: { commands: [openCommand()] } });
    await import("./index");
    fake.fireAlarm("session-poll");
    await vi.waitFor(() => {
      expect(getCommandsMock).toHaveBeenCalledTimes(1);
    });
    const { listSessions } = await import("../session/store");
    await vi.waitFor(async () => {
      expect((await listSessions()).map((session) => session.phase)).toEqual(["waiting"]);
    });
    expect(fake.tabsCreated()).toBe(0);
    expect(postEventMock).not.toHaveBeenCalled();
  });

  it("a closed tab nothing recorded sends nothing", async () => {
    const fake = installFakeChrome(pairing);
    await import("./index");
    fake.removeTab(4242);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(postEventMock).not.toHaveBeenCalled();
  });
});
