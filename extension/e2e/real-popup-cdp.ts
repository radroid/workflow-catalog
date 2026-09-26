/**
 * Raw-CDP helpers for driving the extension's REAL action popup with a
 * genuine activeTab grant, used only by real-popup.spec.ts.
 *
 * Chrome's `activeTab` permission is gesture-gated, and neither Playwright
 * nor Puppeteer's normal APIs (`page.click()` on the toolbar icon isn't
 * reachable at all -- the toolbar is browser chrome, not a page;
 * `chrome.action.openPopup()` and a synthetic `page.keyboard.press()` on
 * the extension were both confirmed dead ends during part A) can produce
 * one. Chrome's own `--enable-unsafe-extension-debugging` launch flag plus
 * the CDP `Extensions.triggerAction` command is a real, first-party
 * invocation of the action button -- indistinguishable, from the
 * extension's point of view, from a genuine click -- and *does* grant
 * activeTab. This is a test-harness-only technique: it requires a
 * Chromium launch flag this repo's shipped extension never asks a real
 * user to pass, and the popup is still driven purely through its own
 * public DOM/JS, no shipped code changed to make this possible.
 *
 * `Extensions.triggerAction` targets a "tab"-type CDP target, which is a
 * different target than the "page" target Playwright's own `Page` object
 * corresponds to (Chrome's target model has one of each per tab). The
 * opened popup is itself a target CDP only reaches via `Target.*`
 * commands -- Playwright's `context.pages()` never sees it. Both are
 * handled here by attaching a raw (non-flattened) CDP session directly
 * (`Target.attachToTarget({ flatten: false })`) and manually correlating
 * `Target.sendMessageToTarget`/`Target.receivedMessageFromTarget` by the
 * numeric id each JSON-RPC message carries -- Playwright's typed
 * `CDPSession.send()` only covers commands sent *to* a target it already
 * knows about in flattened mode, not this bridge-through-the-browser-session
 * pattern, so this layer is deliberately looser-typed than the rest of
 * this file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { extensionDist } from "./fixtures";

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RawCdpSession {
  readonly targetId: string;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** PNG bytes of the target's current compositor frame, taken without
   * resizing the page (see `captureFrame` in `attachRawSession`); the caller
   * verifies and writes it. */
  captureFrame(): Promise<Buffer>;
  pressKey(options: { key: string; code: string; windowsVirtualKeyCode: number; text?: string }): Promise<void>;
  detach(): Promise<void>;
}

interface RawRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

/** How long `captureFrame` waits for the first screencast frame. A frame
 * normally arrives within milliseconds: starting a screencast makes the
 * compositor produce one from the page's current surface even when nothing
 * on the page is changing. */
const FIRST_FRAME_TIMEOUT_MS = 5000;

/** Attaches to any target (tab- or page-typed) via the browser-level
 * session, in non-flattened mode, and returns a small JSON-RPC-over-CDP
 * client for it. Used for both the fixture tab (to force the SPA-mismatch
 * scenario) and the popup itself. */
export async function attachRawSession(bs: CDPSession, targetId: string): Promise<RawCdpSession> {
  const { sessionId } = await bs.send("Target.attachToTarget", { targetId, flatten: false });

  let nextMessageId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  /** One-shot waiters for protocol events (messages with a `method` and no
   * `id`), keyed by method name. */
  const eventWaiters = new Map<string, Array<(params: unknown) => void>>();

  const onMessage = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const parsed = JSON.parse(event.message) as RawRpcMessage;
    if (parsed.id === undefined && parsed.method !== undefined) {
      const waiters = eventWaiters.get(parsed.method);
      if (waiters && waiters.length > 0) {
        eventWaiters.delete(parsed.method);
        for (const waiter of waiters) waiter(parsed.params);
      }
      return;
    }
    if (parsed.id === undefined || !pending.has(parsed.id)) return;
    const waiter = pending.get(parsed.id);
    pending.delete(parsed.id);
    if (!waiter) return;
    if (parsed.error) {
      waiter.reject(new Error(parsed.error.message));
    } else {
      waiter.resolve(parsed.result);
    }
  };
  bs.on("Target.receivedMessageFromTarget", onMessage);

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextMessageId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      bs.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });

  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const raw = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const typed = raw as {
      result?: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (typed.exceptionDetails) {
      const detail = typed.exceptionDetails.exception?.description ?? typed.exceptionDetails.text;
      throw new Error(`evaluate failed for "${expression.slice(0, 120)}": ${detail}`);
    }
    return typed.result?.value as T;
  };

  /** `promise` resolves with the params of the next `method` event on this
   * session, or rejects after `timeoutMs`. Register it before sending the
   * command that triggers the event, so a fast event can't slip past.
   * `cancel` withdraws the wait -- timer and waiter both -- and leaves
   * `promise` unsettled, for when that command itself failed. */
  const nextEvent = (method: string, timeoutMs: number): { promise: Promise<unknown>; cancel: () => void } => {
    let cancel = (): void => undefined;
    const promise = new Promise((resolve, reject) => {
      const withdraw = () => {
        const waiters = eventWaiters.get(method)?.filter((candidate) => candidate !== waiter) ?? [];
        if (waiters.length > 0) eventWaiters.set(method, waiters);
        else eventWaiters.delete(method);
      };
      const waiter = (params: unknown) => {
        clearTimeout(timer);
        resolve(params);
      };
      const timer = setTimeout(() => {
        withdraw();
        reject(new Error(`no ${method} event within ${timeoutMs} ms`));
      }, timeoutMs);
      cancel = () => {
        clearTimeout(timer);
        withdraw();
      };
      eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), waiter]);
    });
    return { promise, cancel };
  };

  /**
   * P07-B revision 2 (iter-005), the CI fix: one frame from a screencast,
   * not `Page.captureScreenshot`.
   *
   * `Page.captureScreenshot` wraps every capture in
   * `WebContents::IncrementCapturerCount`/`DecrementCapturerCount`
   * (content/browser/devtools/protocol/page_handler.cc). While a capture
   * is open, `WebContentsImpl::GetPreferredSize()` reports the capture's
   * own preferred size (empty for a screenshot), and dropping back to no
   * capturers calls `OnPreferredSizeChanged`, which hands the popup's real
   * preferred size back to its auto-sizing delegate. On an extension popup
   * that fires a same-size `resize` in the page during every capture. A
   * DevTools overlay with "show viewport size on resize" on (the DevTools
   * frontend's OverlayModel default; `Overlay.setShowViewportSizeOnResize`
   * on this session can't switch another session's off) then paints its
   * "380px × 404px" label, sometimes into the very frame being captured.
   * Every retry set off the same race again, which is how CI lost all four
   * attempts of P07A-popup-dark.png (run 35758037837). Measured on a real
   * popup: 7 of 8 plain captures carried the label, each fired one
   * `resize`; 0 of 20 screencast frames carried it, and none fired a
   * `resize`.
   *
   * A screencast frame is the compositor's current output: a DOM change
   * made two animation frames before the capture was in every frame
   * checked. `format: "png"` keeps it lossless (desktop screencasts use
   * ARGB frames), at the page's own size in CSS pixels at DPR 1.
   *
   * P07-B revision 3, nit 5: if `Page.startScreencast` itself is refused
   * (the popup closed, the target detached), the frame wait is withdrawn
   * and that refusal is what the caller sees. Before, the wait was left
   * behind and rejected on its own 5 s later with nobody listening -- an
   * unhandled rejection in the test worker.
   */
  const captureFrame = async (): Promise<Buffer> => {
    const frame = nextEvent("Page.screencastFrame", FIRST_FRAME_TIMEOUT_MS);
    try {
      await call("Page.startScreencast", { format: "png" });
    } catch (error) {
      frame.cancel();
      throw error;
    }
    try {
      const params = (await frame.promise) as { data: string; sessionId: number };
      await call("Page.screencastFrameAck", { sessionId: params.sessionId });
      return Buffer.from(params.data, "base64");
    } finally {
      await call("Page.stopScreencast");
    }
  };

  const pressKey = async (options: { key: string; code: string; windowsVirtualKeyCode: number; text?: string }): Promise<void> => {
    const textFields = options.text === undefined ? {} : { text: options.text, unmodifiedText: options.text };
    await call("Input.dispatchKeyEvent", {
      type: options.text === undefined ? "rawKeyDown" : "keyDown",
      key: options.key,
      code: options.code,
      windowsVirtualKeyCode: options.windowsVirtualKeyCode,
      ...textFields,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: options.key,
      code: options.code,
      windowsVirtualKeyCode: options.windowsVirtualKeyCode,
    });
  };

  const detach = async (): Promise<void> => {
    bs.off("Target.receivedMessageFromTarget", onMessage);
    eventWaiters.clear();
    await bs.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  };

  return { targetId, call, evaluate, captureFrame, pressKey, detach };
}

export interface RealPopupHarness {
  context: BrowserContext;
  extId: string;
  bs: CDPSession;
  close(): Promise<void>;
}

/** Launches the built extension in a persistent Chromium context with the
 * one flag that unlocks Extensions.triggerAction. Mirrors e2e/fixtures.ts's
 * `context` fixture (same channel/args rationale, see that file's own
 * header comment) plus this one addition. */
export async function launchWithExtensionDebugging(
  options: { colorScheme?: "light" | "dark" } = {},
): Promise<RealPopupHarness> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "wc-extension-real-popup-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chromium",
    colorScheme: options.colorScheme ?? "light",
    viewport: { width: 400, height: 620 },
    args: [
      `--disable-extensions-except=${extensionDist}`,
      `--load-extension=${extensionDist}`,
      "--enable-unsafe-extension-debugging",
    ],
  });

  const isThisExtension = (url: string) => url.endsWith("/worker.js");
  let worker = context.serviceWorkers().find((sw) => isThisExtension(sw.url()));
  const deadline = Date.now() + 15_000;
  while (!worker && Date.now() < deadline) {
    const event = await context.waitForEvent("serviceworker", { timeout: 1000 }).catch(() => null);
    worker = event && isThisExtension(event.url()) ? event : context.serviceWorkers().find((sw) => isThisExtension(sw.url()));
  }
  if (!worker) {
    throw new Error("Timed out waiting for this extension's service worker (worker.js) to start.");
  }
  const extId = new URL(worker.url()).host;

  const browser = context.browser();
  if (!browser) {
    throw new Error("context.browser() was null -- launchPersistentContext should still expose one for CDP use.");
  }
  const bs = await browser.newBrowserCDPSession();

  const close = async (): Promise<void> => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  };

  return { context, extId, bs, close };
}

/** Polls the popup's own DOM until it leaves the loading state: `preview`
 * once a `renderPreview()` (a `button.primary`) exists, `fallback` once a
 * `renderFallback()` (a `[role="alert"]`) does. Shared by real-popup.spec.ts
 * and bridge-e2e.spec.ts -- both drive the real popup and need to know when
 * it's done reading the tab before interacting with it further. */
export async function waitForPopupState(session: RawCdpSession, timeoutMs = 8000): Promise<"preview" | "fallback"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await session.evaluate<string>(
      `document.querySelector("#app button.primary") ? "preview" : (document.querySelector("#app [role='alert']") ? "fallback" : "loading")`,
    );
    if (state === "preview" || state === "fallback") return state;
    await sleep(100);
  }
  throw new Error("popup never left the loading state");
}

/** Real Tab key presses (CDP Input.dispatchKeyEvent -- a trusted input
 * event, unlike a page-script-dispatched KeyboardEvent, which browsers
 * don't honor for default actions like button activation) until focus
 * lands on the Save button, bounded so a markup change that removes it
 * fails loudly instead of looping forever. */
export async function focusSaveButton(session: RawCdpSession): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const onSaveButton = await session.evaluate<boolean>(
      `document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("primary")`,
    );
    if (onSaveButton) return;
    await session.pressKey({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await sleep(50);
  }
  throw new Error("Tab never reached button.primary within 8 presses");
}

export async function pressEnter(session: RawCdpSession): Promise<void> {
  await session.pressKey({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
}

/** Playwright's `page` corresponds to a "page"-type CDP target;
 * Extensions.triggerAction wants the "tab"-type target for the same tab.
 * Bridges the two by matching URL. */
export async function getTabTargetId(bs: CDPSession, context: BrowserContext, page: Page): Promise<string> {
  const pageSession = await context.newCDPSession(page);
  const { targetInfo } = await pageSession.send("Target.getTargetInfo");
  await pageSession.detach();

  const { targetInfos } = await bs.send("Target.getTargets", { filter: [{ type: "tab" }] });
  const tab = targetInfos.find((info) => info.url === targetInfo.url);
  if (!tab) {
    throw new Error(`No "tab"-type CDP target found for ${targetInfo.url}`);
  }
  return tab.targetId;
}

/** Invokes the extension's default action against the given tab target --
 * a real, first-party action trigger, not a synthetic click -- then polls
 * for the popup's own page target to appear and attaches to it.
 *
 * The first thing sent on that session turns off DevTools' viewport-size
 * label ("380px × 418px", painted top-right after a resize) for this
 * session's own overlay, before the popup resizes itself to fit its preview.
 * That only covers this session's overlay, not the one that actually paints
 * the label, so captures also wait out a resize-quiet period
 * (theme-capture.ts's AFTER_RESIZE_QUIET) and are taken with
 * `captureFrame`, which, unlike `Page.captureScreenshot`, fires no resize of
 * its own. */
export async function triggerRealPopup(bs: CDPSession, extId: string, tabTargetId: string): Promise<RawCdpSession> {
  await bs.send("Extensions.triggerAction", { id: extId, targetId: tabTargetId });

  const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { targetInfos } = await bs.send("Target.getTargets", {});
    const popup = targetInfos.find((info) => info.type === "page" && info.url === popupUrl);
    if (popup) {
      const session = await attachRawSession(bs, popup.targetId);
      await session.call("Overlay.setShowViewportSizeOnResize", { show: false });
      return session;
    }
    await sleep(100);
  }
  throw new Error(`Popup target (${popupUrl}) never appeared within 5s of Extensions.triggerAction.`);
}
