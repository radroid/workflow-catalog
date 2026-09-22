import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDeviceToken,
  getDeviceToken,
  getLastJobCapture,
  setDeviceToken,
  setLastJobCapture,
} from "./storage";

/** A minimal fake of `chrome.storage.session`'s promise-based API, backed
 * by an in-memory object — enough to exercise storage.ts without a real
 * browser. Also records which storage area name was touched, so a test can
 * assert `chrome.storage.local` is never used for these values. */
function createFakeChromeStorage() {
  const sessionData: Record<string, unknown> = {};
  const localData: Record<string, unknown> = {};

  function makeArea(data: Record<string, unknown>) {
    return {
      async get(keys: string | string[] | undefined) {
        if (keys === undefined) return { ...data };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const key of list) {
          if (key in data) out[key] = data[key];
        }
        return out;
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, items);
      },
      async remove(keys: string | string[]) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) delete data[key];
      },
    };
  }

  return {
    session: makeArea(sessionData),
    local: makeArea(localData),
    _sessionData: sessionData,
    _localData: localData,
  };
}

let fakeStorage: ReturnType<typeof createFakeChromeStorage>;

beforeEach(() => {
  fakeStorage = createFakeChromeStorage();
  // @ts-expect-error -- partial chrome stub, enough for storage.ts's surface
  globalThis.chrome = { storage: fakeStorage };
});

describe("device token storage", () => {
  it("round-trips through storage.session", async () => {
    expect(await getDeviceToken()).toBeNull();

    const token = {
      deviceId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      token: "opaque-device-token",
      pairedAt: "2026-09-22T00:00:00.000Z",
    };
    await setDeviceToken(token);
    expect(await getDeviceToken()).toEqual(token);
  });

  it("writes only to storage.session, never storage.local", async () => {
    await setDeviceToken({
      deviceId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      token: "opaque-device-token",
      pairedAt: "2026-09-22T00:00:00.000Z",
    });
    expect(Object.keys(fakeStorage._sessionData)).toContain("deviceToken");
    expect(fakeStorage._localData).toEqual({});
  });

  it("un-pair clears the token", async () => {
    await setDeviceToken({
      deviceId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      token: "opaque-device-token",
      pairedAt: "2026-09-22T00:00:00.000Z",
    });
    await clearDeviceToken();
    expect(await getDeviceToken()).toBeNull();
  });
});

describe("last job capture handoff storage", () => {
  it("round-trips through storage.session and never touches storage.local", async () => {
    expect(await getLastJobCapture()).toBeNull();

    const capture = {
      protocol: 1 as const,
      type: "job_capture" as const,
      eventId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      url: "https://jobs.example/postings/1",
      text: "Backend Engineer — Quill",
      extractorVersion: "extractor@0.1.0",
      contentHash: "a".repeat(64),
      occurredAt: "2026-09-22T00:00:00.000Z",
    };
    await setLastJobCapture(capture);
    expect(await getLastJobCapture()).toEqual(capture);
    expect(fakeStorage._localData).toEqual({});
  });
});
