import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDeviceToken,
  flagOriginMismatch,
  forgetInvalidToken,
  forgetPairing,
  getDeviceToken,
  getLastJobCapture,
  getPairedBefore,
  getPairingExpired,
  getPairingOriginMismatch,
  recordPairing,
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

describe("P07-B revision 2, B4: the 401/403 hooks only touch the token the bridge refused", () => {
  const OLD = { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "old-token", pairedAt: "2026-09-22T09:00:00.000Z" };
  const NEW = { deviceId: "9c1d7a1f-3a2b-4d66-8e4f-1b2c3d4e5f60", token: "new-token", pairedAt: "2026-09-22T09:05:00.000Z" };

  it("forgetInvalidToken clears the stored token, and records the expiry, when it is the refused one", async () => {
    await recordPairing(OLD);
    await forgetInvalidToken("old-token");
    expect(await getDeviceToken()).toBeNull();
    expect(await getPairingExpired()).toBe(true);
  });

  it("forgetInvalidToken leaves a newer pairing alone", async () => {
    await recordPairing(NEW);
    await forgetInvalidToken("old-token");
    expect(await getDeviceToken()).toEqual(NEW);
    expect(await getPairingExpired()).toBe(false);
  });

  it("forgetInvalidToken does nothing once the token is already gone (Un-pair got there first)", async () => {
    await forgetInvalidToken("old-token");
    expect(await getPairingExpired()).toBe(false);
  });

  it("flagOriginMismatch flags only the stored token", async () => {
    await recordPairing(NEW);
    await flagOriginMismatch("old-token");
    expect(await getPairingOriginMismatch()).toBe(false);
    await flagOriginMismatch("new-token");
    expect(await getPairingOriginMismatch()).toBe(true);
  });

  it("recordPairing clears both flags and remembers the pairing; forgetPairing clears the token and flags but not that memory", async () => {
    expect(await getPairedBefore()).toBe(false);
    await recordPairing(OLD);
    await flagOriginMismatch("old-token");
    await forgetInvalidToken("old-token");
    expect(await getPairingOriginMismatch()).toBe(true);
    expect(await getPairingExpired()).toBe(true);

    await recordPairing(NEW);
    expect(await getPairingOriginMismatch()).toBe(false);
    expect(await getPairingExpired()).toBe(false);
    expect(await getPairedBefore()).toBe(true);

    await flagOriginMismatch("new-token");
    await forgetPairing();
    expect(await getDeviceToken()).toBeNull();
    expect(await getPairingOriginMismatch()).toBe(false);
    expect(await getPairedBefore(), "the next code still comes from npm run pair").toBe(true);
    expect(fakeStorage._localData).toEqual({});
  });
});

describe("P07 part C (carried): the forgetInvalidToken window is closed by the pairing lock", () => {
  const OLD = { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "old-token", pairedAt: "2026-09-22T09:00:00.000Z" };
  const NEW = { deviceId: "9c1d7a1f-3a2b-4d66-8e4f-1b2c3d4e5f60", token: "new-token", pairedAt: "2026-09-22T09:05:00.000Z" };

  /** Makes every storage.session read take a timer tick, so a second call started right after the first
   * would land between the first's read and its removal -- revision 2's window. */
  function slowReads(): void {
    const get = fakeStorage.session.get.bind(fakeStorage.session);
    fakeStorage.session.get = async (keys) => {
      const value = await get(keys);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    };
  }

  it("a pairing stored while a 401's forgetInvalidToken is still reading waits for it, and is never the token removed", async () => {
    await recordPairing(OLD);
    slowReads();
    const forgetting = forgetInvalidToken("old-token");
    const pairing = recordPairing(NEW);
    await Promise.all([forgetting, pairing]);
    expect(await getDeviceToken(), "revision 2 lost this pairing").toEqual(NEW);
    expect(await getPairingExpired(), "and the new pairing cleared the old one's expiry").toBe(false);
  });

  it("an Un-pair and a 403's flag are serialised the same way", async () => {
    await recordPairing(OLD);
    slowReads();
    await Promise.all([flagOriginMismatch("old-token"), forgetPairing()]);
    expect(await getDeviceToken()).toBeNull();
    expect(await getPairingOriginMismatch(), "the Un-pair ran after the flag, and cleared it").toBe(false);
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
