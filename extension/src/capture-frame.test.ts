// @vitest-environment node
/**
 * P07-B revision 3, nit 5: `captureFrame` (e2e/real-popup-cdp.ts) when
 * `Page.startScreencast` is refused -- the popup closed, or the target
 * detached. The caller gets that refusal, and the frame wait is withdrawn
 * with it. Revision 2 left the wait behind: 5 s later it rejected with
 * nobody listening, an unhandled rejection in the test worker.
 *
 * A fake browser-level CDP session stands in for Chrome; no browser, no
 * ports. It lives under src/ because vitest.config.ts excludes e2e/**.
 */
import type { CDPSession } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRawSession } from "../e2e/real-popup-cdp";

type Listener = (event: { sessionId: string; message: string }) => void;
type Reply = { result: Record<string, unknown> } | { error: { message: string } };

const SESSION_ID = "popup-session";

/** A browser-level session whose target answers each command with
 * `reply(method)`; `frameAfterStart` is the screencast frame it sends once
 * `Page.startScreencast` succeeds (none: the frame never comes). */
function fakeBrowserSession(
  reply: (method: string) => Reply,
  frameAfterStart?: { data: string; sessionId: number },
): { bs: CDPSession; sent: string[] } {
  const listeners = new Set<Listener>();
  const sent: string[] = [];
  const deliver = (message: unknown) => {
    for (const listener of listeners) listener({ sessionId: SESSION_ID, message: JSON.stringify(message) });
  };
  const bs = {
    on: (_event: string, listener: Listener) => {
      listeners.add(listener);
    },
    off: (_event: string, listener: Listener) => {
      listeners.delete(listener);
    },
    send: async (method: string, params: { message?: string } = {}) => {
      if (method === "Target.attachToTarget") return { sessionId: SESSION_ID };
      if (method === "Target.detachFromTarget") return {};
      if (method !== "Target.sendMessageToTarget" || params.message === undefined) throw new Error(`unexpected ${method}`);
      const command = JSON.parse(params.message) as { id: number; method: string };
      sent.push(command.method);
      const answer = reply(command.method);
      queueMicrotask(() => {
        deliver({ id: command.id, ...answer });
        if (command.method === "Page.startScreencast" && "result" in answer && frameAfterStart) {
          deliver({ method: "Page.screencastFrame", params: frameAfterStart });
        }
      });
      return {};
    },
  };
  return { bs: bs as unknown as CDPSession, sent };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  process.off("unhandledRejection", onUnhandled);
});

/** Runs the clock past captureFrame's 5 s frame wait, then lets Node report
 * any rejection nobody handled. */
async function outlastTheFrameWait(): Promise<void> {
  await vi.advanceTimersByTimeAsync(6000);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("captureFrame (P07-B revision 3, nit 5)", () => {
  it("a refused Page.startScreencast rejects with that refusal, and leaves no frame wait behind to reject later", async () => {
    const { bs, sent } = fakeBrowserSession((method) =>
      method === "Page.startScreencast" ? { error: { message: "Target closed." } } : { result: {} },
    );
    const session = await attachRawSession(bs, "popup-target");

    await expect(session.captureFrame()).rejects.toThrow("Target closed.");
    await outlastTheFrameWait();

    expect(unhandled, "revision 2's abandoned frame wait rejected here, 5 s later, with nobody listening").toEqual([]);
    expect(sent, "no screencast was started, so there is none to stop").toEqual(["Page.startScreencast"]);
  });

  it("control: a started screencast returns the frame's PNG bytes, acknowledges the frame and stops the screencast", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { bs, sent } = fakeBrowserSession(() => ({ result: {} }), { data: png.toString("base64"), sessionId: 7 });
    const session = await attachRawSession(bs, "popup-target");

    expect(await session.captureFrame()).toEqual(png);
    await outlastTheFrameWait();

    expect(sent).toEqual(["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"]);
    expect(unhandled).toEqual([]);
  });

  it("no frame within 5 s rejects the capture, and the screencast is still stopped", async () => {
    const { bs, sent } = fakeBrowserSession(() => ({ result: {} }));
    const session = await attachRawSession(bs, "popup-target");

    const capture = session.captureFrame();
    const refused = expect(capture).rejects.toThrow("no Page.screencastFrame event within 5000 ms");
    await outlastTheFrameWait();
    await refused;

    expect(sent).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(unhandled).toEqual([]);
  });
});
