/**
 * P07-B acceptance gates, proven at the UI layer: the real options and
 * popup pages (Playwright driving the actual built extension, the same
 * `--enable-unsafe-extension-debugging` harness real-popup.spec.ts uses)
 * against a real, listening P02 bridge (e2e/real-bridge-harness.ts, the
 * same harness src/shared/bridge-client.realbridge.test.ts drives
 * directly, no browser). That vitest file already proves the bridge
 * client's own request/response handling against the real bridge; this
 * file closes the remaining gap -- that a person actually SEES the right
 * thing happen in the rendered extension pages, not just that the
 * underlying client call resolves correctly.
 *
 * Covers, each as a genuine end-to-end path (real fetch, real bridge, real
 * rendered DOM, never a mocked BridgeClient):
 *   - pairing success/error UI, and Un-pair (deliverable 1)
 *   - the options page's Status section's recoverable states
 *     (deliverable 2) for gate 6 (revoke, expiry) and gate 9's runner-not-
 *     running half
 *   - job_capture's single "saved and sent" success state (gate 1), the
 *     offline-queue-then-delivered path (gate 4, deliverable 3), and gate
 *     9's wrong-extension-id half -- through the popup, not the options
 *     page: GET /status carries no Origin header at all (Chrome doesn't
 *     send one on a GET; see runner/server/extension-api.ts), so a
 *     mismatched-origin token is indistinguishable from a valid one to
 *     that route, and only actually shows up on job_capture's POST
 *     /events, the only authenticated POST this extension makes
 *   - the P07B acceptance screenshots (docs/screenshots/P07B-*.png): every
 *     options and popup state above and the ones only a stand-in on the
 *     bridge's port can produce (a refusal, another program on the port, a
 *     re-pair landing mid-Save), light and dark, options at 1280 and 390,
 *     each checked (axe, empty regions, [hidden], split commands) before
 *     theme-capture.ts's captureInTheme (shared with real-popup.spec.ts's
 *     own P07A screenshots) takes it -- opt-in writes gated on
 *     P07B_UPDATE_SCREENSHOTS=1, see screenshotPath below
 *
 * Runs serially (test.describe.configure below) against ONE shared
 * Chromium context/extension instance, like real-popup.spec.ts, but starts
 * a *fresh* bridge (fresh temp workspace, fresh pairing/device state, see
 * real-bridge-harness.ts) on 127.0.0.1:4310 -- the one port the manifest's
 * host permission allows, and the one `BRIDGE_ORIGIN` in
 * shared/bridge-client.ts is hard-coded to -- before each test, and clears
 * chrome.storage.session so no test starts holding a token or outbox entry
 * a previous one left behind.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page, Route } from "@playwright/test";
import type { JobCapture } from "@workflow-catalog/contracts";
import { DEVICE_TOKEN_TTL_MS } from "@workflow-catalog/runner/store/devices.ts";
import { JobsStore } from "@workflow-catalog/runner/store/jobs.ts";
import { listen } from "@workflow-catalog/runner/server/app.ts";
import {
  assertNoAxeViolations,
  expectEmptyRegionsCollapsed,
  expectHiddenReallyHidden,
  expectNoSplitCommands,
  expectReadableInertButton,
  waitForDownload,
} from "./checks";
import { installAnnouncementRecorder, takeAnnouncements } from "./announcements";
import { expect, extensionDist, test } from "./fixtures";
import { startFixtureServer, type FixtureServerHandle } from "./fixture-server";
import {
  focusSaveButton,
  getTabTargetId,
  launchWithExtensionDebugging,
  pressEnter,
  sleep,
  triggerRealPopup,
  waitForPopupState,
  type RawCdpSession,
  type RealPopupHarness,
} from "./real-popup-cdp";
import {
  cleanScratchWorkspaces,
  pairFictionalDevice,
  startBridgeHarness,
  type BridgeHarness,
} from "./real-bridge-harness";
import { AFTER_RESIZE_QUIET, captureInTheme, inTheme, pageThemeTarget, popupThemeTarget } from "./theme-capture";

const here = path.dirname(fileURLToPath(import.meta.url));
const committedScreenshotsDir = path.resolve(here, "../../docs/screenshots");

/** The committed P07B acceptance screenshots are rewritten only on request
 * (`P07B_UPDATE_SCREENSHOTS=1 pnpm --filter @workflow-catalog/extension
 * test:e2e`), the same opt-in shape P07A_UPDATE_SCREENSHOTS uses in
 * real-popup.spec.ts. A normal run writes the same verified captures into
 * this test's own output dir under test-results/ (gitignored), so
 * `test:e2e` never dirties the working tree. */
function screenshotPath(fileName: string): string {
  return process.env.P07B_UPDATE_SCREENSHOTS === "1"
    ? path.join(committedScreenshotsDir, fileName)
    : test.info().outputPath(fileName);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!existsSync(extensionDist)) {
    throw new Error(`extension/dist not found — run "pnpm --filter @workflow-catalog/extension build" first.`);
  }
});

let harness: RealPopupHarness;
let fixtureServer: FixtureServerHandle;
let downloadDir: string;

test.beforeAll(async () => {
  fixtureServer = await startFixtureServer();
  harness = await launchWithExtensionDebugging({ colorScheme: "light" });
  downloadDir = mkdtempSync(path.join(tmpdir(), "wc-bridge-e2e-downloads-"));
  await harness.bs.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
});

test.afterAll(async () => {
  await harness?.close();
  await fixtureServer?.close();
  rmSync(downloadDir, { recursive: true, force: true });
});

let bridge: BridgeHarness;

test.beforeEach(async () => {
  // P07 part C (carried from the P04 round-1 review): the bridge `npm run
  // runner` starts, with every real route module, so a Save reaches P04's
  // job_capture handler instead of being journaled as no_handler.
  bridge = await startBridgeHarness({ modules: "real" });
  // Every test starts from a genuinely clean slate, whatever a previous
  // one in this file left in chrome.storage.session (a token, a queued
  // outbox entry) -- this extension instance is shared across all tests
  // (one persistent context, see the beforeAll above), but each test's
  // bridge is brand new, so a stale token would otherwise mean nothing
  // (unpaired-shaped 401) starts out true only by coincidence.
  // chrome.storage is only reachable from a page on this extension's own
  // origin, not an arbitrary blank page -- the options page qualifies and
  // every test opens one anyway.
  const scratch = await harness.context.newPage();
  await scratch.goto(optionsUrl());
  await scratch.evaluate(() => chrome.storage.session.clear());
  await scratch.close();
});

test.afterEach(async () => {
  await bridge.bridge.close();
  await cleanScratchWorkspaces();
});

function optionsUrl(): string {
  return `chrome-extension://${harness.extId}/src/options/index.html`;
}

/** The side panel: an extension page that can reach chrome.storage.session
 * and, once its first check is done, sends nothing on its own -- unlike the
 * options page, whose status check would act on a token a test is
 * swapping. */
function sidePanelUrl(): string {
  return `chrome-extension://${harness.extId}/src/sidepanel/index.html`;
}

/** P07 part C: the side panel checks the runner for sessions once when it
 * opens. Opened unpaired (every test starts with storage cleared), that
 * check sends nothing; waiting for it to finish first means a token a test
 * stores next is never the one it uses. After that the panel only listens
 * to storage (and to its own buttons). */
async function openQuietStoragePage(): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(sidePanelUrl());
  await expect(page.locator('[data-section="connection"]')).toContainText("Pair this browser in Settings to receive sessions from the runner.");
  return page;
}

/** The popup's status line: its text and its tone class. */
async function popupStatus(popup: RawCdpSession): Promise<{ text: string; className: string }> {
  return popup.evaluate<{ text: string; className: string }>(`(() => {
    const status = document.querySelector('[role="status"]');
    return { text: status.textContent, className: status.className };
  })()`);
}

/** Polls the popup's status line until it contains `fragment` (a Save's
 * outcome lands after its request settles), then returns it. */
async function waitForPopupStatus(popup: RawCdpSession, fragment: string): Promise<{ text: string; className: string }> {
  let status = await popupStatus(popup);
  for (let attempt = 0; attempt < 30 && !status.text.includes(fragment); attempt += 1) {
    await sleep(100);
    status = await popupStatus(popup);
  }
  return status;
}

/** Stores a fictional device token as this browser's pairing, from an
 * extension page (`page`) -- for the stand-in tests, where no real bridge
 * issued it. */
async function storeFictionalPairing(page: Page, deviceId: string, token: string): Promise<void> {
  await page.evaluate(
    async (stored) => {
      await chrome.storage.session.set({ deviceToken: { ...stored, pairedAt: new Date().toISOString() } });
    },
    { deviceId, token },
  );
}

/** Opens a fresh options page and waits for its first `GET /status` (part
 * of `render()`'s own async work) to have settled, so a test's first
 * assertion right after this isn't racing that initial render. */
async function openFreshOptionsPage(): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(optionsUrl());
  await page.locator('[data-section="status"]').waitFor();
  return page;
}

/** The options page's Pairing form, filled and submitted the way a person
 * actually would -- real Playwright input/click, a real POST /pair to
 * `bridge`, a real re-render on the response. The label credits `npm run
 * setup` on a fresh browser session and `npm run pair` once this one has
 * paired before (P07-B revision 2 polish); tests that care which assert it
 * themselves. */
async function pairThroughTheRealForm(page: Page, code: string): Promise<void> {
  await page.getByLabel(/^Code from npm run (setup|pair)$/).fill(code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveText("Paired.");
  // The pair handler's own refreshStatusSection() call is a second,
  // separate network round trip after the DOM already shows "Paired." --
  // its own click handler is a fire-and-forget async IIFE
  // (`void (async () => {...})()` in options/main.ts), so Playwright's
  // .click() above does not itself wait for it. Every caller here goes on
  // to read the Status section, so wait for it to actually settle instead
  // of letting each call site race that second fetch on its own.
  await expect(statusOk(page)).toContainText("Connected");
}

/** The Status section's failure body (`role="alert"`) -- present only for
 * network_error/401/403/429; absent for not-paired and connected, which
 * use `role="status"` instead (see `statusOk`). */
function statusAlert(page: Page): Locator {
  return page.locator('[data-section="status"] [role="alert"]');
}

/** The Status section's non-failure body (`role="status"`) -- a plain
 * message for not-paired, or the connected `dl.kv` for a real GET /status
 * 200. */
function statusOk(page: Page): Locator {
  return page.locator('[data-section="status"] [role="status"]');
}

/**
 * Holds 127.0.0.1:`port` open like a runner that is up but stuck: it
 * accepts every connection and never sends a byte, so the extension's
 * request can only end by its own 5 s timeout (P07-B revision 1, B4) --
 * "The runner isn't responding.", not the refused-connection "Can't reach
 * the runner." (P07-B revision 2, C5).
 */
async function holdPortSilently(port: number): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A minimal HTTP listener on 127.0.0.1:`port` -- only for the one state
 * the real bridge can't be driven into from a real Save (see its test). */
async function serveOnPort(port: number, handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ close(): Promise<void> }> {
  const server = createHttpServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** `{dt: dd}` pairs from the first `dl.kv` under `scope`, the same shape
 * real-popup.spec.ts's own `readKvPairs` reads from the popup via CDP --
 * this is the Playwright-`Locator` equivalent for the options page. */
async function readKvPairs(scope: Locator): Promise<Record<string, string>> {
  return scope.evaluate((el) =>
    Object.fromEntries(
      Array.from(el.querySelectorAll("dl.kv dt")).map((dt) => [
        dt.textContent ?? "",
        dt.nextElementSibling ? (dt.nextElementSibling.textContent ?? "") : "",
      ]),
    ),
  );
}

test("pairing: a real code pairs, shows a device id and flips Status to connected, and Un-pair forgets it", async () => {
  const page = await openFreshOptionsPage();

  await expect(statusOk(page)).toHaveText("Pair this browser above to see the runner's status.");

  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);

  const pairingSection = page.locator('[data-section="pairing"]');
  await expect(pairingSection.locator("dl.kv dt")).toHaveText(["Device", "Paired"]);
  // P07-B revision 2, D: the code form collapses behind "Pair again" once
  // paired -- a .stack, hidden only because base.css's [hidden] rule beats
  // .stack's own display:flex.
  await expect(pairingSection.locator("form")).toBeHidden();
  await expectHiddenReallyHidden((expression) => page.evaluate(expression), "options, paired");

  // Real, end to end: the Status section (re-fetched right after pairing,
  // options/main.ts's refreshStatusSection) shows this exact bridge's own
  // version/workspace, not a stub.
  const kv = await readKvPairs(statusOk(page));
  expect(kv.Connected).toBe("Yes");
  expect(kv.Version).toBe("0.1.0-test");
  // Polish (P07-B revision 1): the full workspace UUID crowded this row --
  // abbreviateUuid shows only its first 8 characters plus an ellipsis, with
  // the full value still reachable via the dd's own title attribute (same
  // treatment Device's id already gets above).
  const workspaceId = bridge.ctx.workspace.manifest.workspaceId;
  expect(kv.Workspace).toBe(`${workspaceId.slice(0, 8)}…`);
  const workspaceDd = statusOk(page).locator("dl.kv dd").nth(2);
  await expect(workspaceDd).toHaveAttribute("title", workspaceId);

  await page.getByRole("button", { name: "Un-pair" }).click();
  await expect(pairingSection.locator('[role="status"]')).toHaveText("Un-paired. You can pair again below.");
  await expect(pairingSection.getByRole("link", { name: "status page" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:4310/ui/status",
  );
  // Status flips back too -- the same GET /status is now unauthenticated.
  await expect(statusOk(page)).toHaveText("Pair this browser above to see the runner's status.");
  // Unpaired, there is nothing to un-pair: that row (a .row) is hidden.
  await expect(page.getByRole("button", { name: "Un-pair" })).toBeHidden();
  await expectHiddenReallyHidden((expression) => page.evaluate(expression), "options, after Un-pair");

  await page.close();
});

test("pairing: a wrong code shows the bridge's own error message and marks the field invalid", async () => {
  const page = await openFreshOptionsPage();
  await bridge.ctx.pairing.issue(); // a real code exists; deliberately not the one used below

  const codeInput = page.getByLabel("Code from npm run setup");
  await codeInput.fill("ZZZZZ-ZZZZZ");
  await page.getByRole("button", { name: "Pair", exact: true }).click();

  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveText(
    "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run npm run pair for a new one.",
  );
  await expect(codeInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator('[data-section="pairing"]')).toContainText("Not paired yet.");

  await page.close();
});

test("status (gate 6): a clear re-pair state once the device is revoked, and once its token has expired", async () => {
  const page = await openFreshOptionsPage();

  await test.step("revoked", async () => {
    const { code } = await bridge.ctx.pairing.issue();
    await pairThroughTheRealForm(page, code);
    expect((await readKvPairs(statusOk(page))).Connected).toBe("Yes");

    const deviceId = await page.evaluate(async () => {
      const stored = await chrome.storage.session.get("deviceToken");
      return (stored.deviceToken as { deviceId: string } | undefined)?.deviceId;
    });
    // P07-B revision 1, B6: a real type error lived here (deviceId is
    // string | undefined -- pairThroughTheRealForm above already asserts
    // Connected: Yes, so an undefined deviceId at this point means
    // chrome.storage.session itself is broken, not that revoke() should
    // silently no-op on it). Narrow with a real runtime check instead of
    // an `as string` cast, so a genuine regression here still fails loud.
    if (deviceId === undefined) throw new Error("expected a deviceId in chrome.storage.session after pairing, got none");
    expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);

    await page.reload();
    await expect(statusAlert(page)).toHaveText("Your pairing has expired or was revoked. Pair again above.");
    // P07-B revision 3, UI issue 1: the Pairing card says what is true
    // now -- not "Paired." (revision 2 kept the last outcome), and not
    // "Not paired yet." for a browser that was paired. Revision 4, K1: in
    // the notice slot, which isn't a live region.
    const pairingSection = page.locator('[data-section="pairing"]');
    await expect(pairingSection.locator("[data-notice]")).toHaveText("Your pairing expired or was revoked.");
    await expect(pairingSection.locator('[role="status"]')).toHaveText("");
    await expect(pairingSection).toContainText("Not paired.");
    await expect(pairingSection).not.toContainText("Not paired yet.");

    // P07-B revision 2 polish: the 401 forgot the token, but not that this
    // browser was paired -- the next code comes from npm run pair, and a
    // re-check (here, "Check again") keeps saying the pairing expired
    // rather than "Pair this browser above…".
    await expect(page.locator('[data-section="pairing"] label[for]')).toHaveText("Code from npm run pair");
    // By reference, not by name: the name reads "Checking…" while it
    // checks (held for at least 600 ms -- revision 3 polish).
    const checkAgain = page.locator('[data-section="status"] button');
    await expect(checkAgain).toHaveText("Check again");
    await checkAgain.click();
    await expect(checkAgain).toHaveText("Checking…");
    await expect(checkAgain).toHaveText("Check again");
    await expect(checkAgain, "revision 1 rebuilt the section and dropped focus to <body>").toBeFocused();
    await expect(statusAlert(page)).toHaveText("Your pairing has expired or was revoked. Pair again above.");
    await expect(statusOk(page)).toHaveText("");
  });

  await test.step("expired", async () => {
    // The revoked device above can never recover; pair fresh, then move
    // the bridge's own clock forward past DEVICE_TOKEN_TTL_MS -- the same
    // expiry bridge-client.realbridge.test.ts proves at the client layer,
    // checked here at the rendered UI layer instead.
    const { code } = await bridge.ctx.pairing.issue();
    await pairThroughTheRealForm(page, code);
    expect((await readKvPairs(statusOk(page))).Connected).toBe("Yes");

    bridge.clock.advance(DEVICE_TOKEN_TTL_MS + 1);
    await page.reload();
    await expect(statusAlert(page)).toHaveText("Your pairing has expired or was revoked. Pair again above.");
  });

  await page.close();
});

test("K1 (P07-B revision 4): a refused pairing is announced once, by Status's alert -- after Check again, a window-focus re-check, and on opening Settings", async () => {
  // What a screen reader would say, recorded in the page from its own DOM
  // changes (e2e/announcements.ts, the recorder the unit tests use too).
  // Revision 3 also announced the Pairing line a millisecond after the
  // alert, in all three cases (the round-4 critic's S6, S7 and S8).
  const ALERT = "Your pairing has expired or was revoked. Pair again above.";
  const NOTICE = "Your pairing expired or was revoked.";
  test.setTimeout(60_000);

  /** A fresh options page paired through the real form, recording what is
   * announced -- first shown to hear the page's own "Paired.". */
  async function pairedPage(): Promise<{ page: Page; deviceId: string }> {
    const page = await openFreshOptionsPage();
    await page.evaluate(installAnnouncementRecorder);
    const { code } = await bridge.ctx.pairing.issue();
    await pairThroughTheRealForm(page, code);
    expect(await page.evaluate(takeAnnouncements), "the recorder hears the live line").toContain("Paired.");
    const deviceId = await page.evaluate(async () => {
      const stored = await chrome.storage.session.get("deviceToken");
      return (stored.deviceToken as { deviceId: string } | undefined)?.deviceId;
    });
    if (deviceId === undefined) throw new Error("expected a deviceId in chrome.storage.session after pairing, got none");
    return { page, deviceId };
  }

  const notice = (page: Page): Locator => page.locator('[data-section="pairing"] [data-notice]');

  await test.step("Check again after a revoke", async () => {
    const { page, deviceId } = await pairedPage();
    expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);
    const checkAgain = page.locator('[data-section="status"] button');
    await checkAgain.focus();
    await page.evaluate(takeAnnouncements);
    await page.keyboard.press("Enter");
    await expect(statusAlert(page)).toHaveText(ALERT);
    await expect(notice(page)).toHaveText(NOTICE);
    await expect(checkAgain).toHaveText("Check again");
    // Late enough to hear anything said after the alert.
    await sleep(500);
    expect(await page.evaluate(takeAnnouncements)).toEqual([ALERT]);
    await expect(page.locator('[data-section="pairing"] [role="status"]'), "'Paired.' is gone").toHaveText("");
    await expect(checkAgain).toBeFocused();
    await page.close();
  });

  await test.step("the window-focus re-check after a revoke, with focus in the card", async () => {
    const { page, deviceId } = await pairedPage();
    expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);
    await page.getByRole("button", { name: "Un-pair" }).focus();
    await page.evaluate(takeAnnouncements);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(statusAlert(page)).toHaveText(ALERT);
    const codeField = page.locator('[data-section="pairing"] input[type="text"]');
    await expect(codeField, "the Un-pair button went with the old card").toBeFocused();
    await expect(codeField, "read when focus lands, not announced").toHaveAccessibleDescription(NOTICE);
    await sleep(500);
    expect(await page.evaluate(takeAnnouncements)).toEqual([ALERT]);
    await page.close();
  });

  await test.step("opening Settings while the runner refuses the stored token", async () => {
    const { page, deviceId } = await pairedPage();
    expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);
    await page.addInitScript(installAnnouncementRecorder);
    await page.reload();
    await expect(statusAlert(page)).toHaveText(ALERT);
    await expect(notice(page)).toHaveText(NOTICE);
    await sleep(500);
    expect(await page.evaluate(takeAnnouncements)).toEqual([ALERT]);
    await page.close();
  });
});

test("status (gate 9): a clear state when the runner isn't running", async () => {
  const page = await openFreshOptionsPage();

  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);

  await bridge.bridge.close();
  await page.reload();
  await expect(statusAlert(page)).toHaveText("Can't reach the runner. Is it running? Start it with npm run runner.");

  // Restart so afterEach's close() (already-closed is a needless risk) and
  // this file's other tests see a bridge in the state startBridgeHarness
  // always hands back.
  bridge.bridge = await listen(bridge.app, bridge.port);

  await page.close();
});

test("job_capture (gate 1): Save shows a single success state, against the real bridge", async () => {
  // Pair via the real options page first -- chrome.storage.session is
  // shared across this extension's contexts (worker/popup/options), so a
  // token stored here is what the popup's own bridgeClient reads too.
  const optionsPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(optionsPage, code);
  await optionsPage.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  // P07-B revision 1, E1: the bridge is tried first and accepts it, so
  // Save downloads nothing here -- "Sent to the runner." is the whole
  // status line, not a "Saved <file> and sent..." combination the way
  // part A's always-download design used to word it.
  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("Sent to the runner")) break;
    await sleep(100);
  }
  expect(statusText).toBe("Sent to the runner.");
  const buttonText = await popup.evaluate<string>(`document.querySelector("button.primary").textContent`);
  expect(buttonText).toBe("Saved ✓");

  // Real, end to end: the bridge's own journal has exactly one entry --
  // gate 1 is that a replay never double-journals; this is the "saved
  // once, for real" half a UI-only check can't see.
  const journaled = await bridge.ctx.journal.list();
  expect(journaled).toHaveLength(1);

  // P07 part C (carried from the P04 round-1 review): and it reached P04's
  // real handler -- the capture is the job's first revision in the
  // workspace, not an event with no handler.
  const jobs = new JobsStore(bridge.ctx.workspace);
  const jobId = await jobs.findJobIdByUrl(`${fixtureServer.origin}/posting-json-ld.html`);
  expect(jobId, "the capture landed as a job").toBeDefined();
  expect(await jobs.revisions(jobId!)).toEqual([1]);
  const snapshot = await jobs.getSnapshot(jobId!, 1);
  expect(snapshot?.text).toContain("Staff Software Engineer");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("job_capture (gate 9, wrong extension id): Save still shows a clear recoverable state, and the bridge safely refuses it", async () => {
  // /status is a GET, and Chrome never sends an Origin header on a GET
  // (runner/server/extension-api.ts's own header comment: "GET or HEAD
  // with no Origin: accepted on the device token alone") -- so a
  // mismatched-origin token is indistinguishable from a valid one to
  // GET /status, and this scenario can only actually be observed on a
  // POST, where Chrome does set a real Origin. job_capture's Save is the
  // only authenticated POST this extension makes, so it's exercised here
  // instead of the options page (an earlier version of this file tried
  // this through the Status section; the real bridge just returns 200,
  // exactly per that comment, so it never got to see a 403 at all).
  const otherOrigin = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
  const mismatched = await pairFictionalDevice(bridge, otherOrigin);
  const seedPage = await harness.context.newPage();
  await seedPage.goto(optionsUrl());
  await seedPage.evaluate(async (token) => {
    await chrome.storage.session.set({
      deviceToken: { deviceId: token.deviceId, token: token.token, pairedAt: new Date().toISOString() },
    });
  }, mismatched);
  await seedPage.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("different install")) break;
    await sleep(100);
  }
  // P07-B revision 1, B3: sendToBridge branches on status/code instead of
  // one blanket "isn't reachable right now" for every failure -- a real,
  // wrong-extension-id 403 from the real bridge gets its own specific
  // message (and, like every queued outcome, offers "Open settings" --
  // Settings is exactly what can fix a wrong pairing), not a generic
  // network-error-shaped one.
  expect(statusText).toBe("This pairing belongs to a different install. Pair again in Settings.");

  // And the bridge itself genuinely refused it -- the capture is queued
  // client-side, but never journaled: gate 9 is that a mismatched device
  // gets no further authorized access, not just that the popup looks calm
  // about it.
  const journaled = await bridge.ctx.journal.list();
  expect(journaled).toHaveLength(0);

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("job_capture (gate 4): Save queues when the runner is unreachable, and the queued capture is delivered once it's back", async () => {
  // FIRST_RETRY_DELAY_MINUTES (shared/outbox.ts) is 0.5 -- this test
  // really does wait out that alarm below, not simulate it, plus margin.
  test.setTimeout(120_000);

  const optionsPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(optionsPage, code);
  await optionsPage.close();

  // The runner isn't running: close the bridge before the popup ever
  // tries to reach it.
  await bridge.bridge.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-dom-heuristics.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("isn't reachable right now")) break;
    await sleep(100);
  }
  expect(statusText).toBe("The runner isn't reachable right now — it'll be sent automatically once it's back.");

  // P07-B revision 1, B2: the outbox moved from one array under a single
  // "jobCaptureOutbox" key to one key per entry ("jobCaptureOutbox:
  // <eventId>", shared/outbox.ts's OUTBOX_KEY_PREFIX) so concurrent writes
  // from different contexts (popup vs. worker) never race each other --
  // get(null) (chrome's own "everything" form, the same call readOutbox()
  // itself makes) and a prefix filter is how anything outside that module
  // has to enumerate it now.
  const queuedEventId = await popup.evaluate<string | undefined>(`
    chrome.storage.session.get(null).then((all) => {
      const key = Object.keys(all).find((k) => k.startsWith("jobCaptureOutbox:"));
      return key ? all[key]?.capture?.eventId : undefined;
    })
  `);
  expect(queuedEventId).toBeTruthy();

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();

  // The runner is back: restart the SAME app/ctx (same workspace, same
  // paired device) on the SAME port, so the queued capture's token is
  // still valid when the alarm retries it.
  bridge.bridge = await listen(bridge.app, bridge.port);

  // chrome.alarms wakes the (possibly-idled) service worker back up when
  // it fires -- no page needs to stay open for that. Poll the bridge's own
  // journal (ground truth, independent of anything client-rendered) for
  // real delivery, generous margin over the nominal 30s.
  const deadline = Date.now() + 60_000;
  let delivered = false;
  while (Date.now() < deadline) {
    if ((await bridge.ctx.journal.list()).some((entry) => entry.eventId === queuedEventId)) {
      delivered = true;
      break;
    }
    await sleep(1000);
  }
  expect(delivered, "the queued capture was never journaled by the bridge after it came back").toBe(true);

  // And the client side's own queue emptied too, not just the server side.
  // The bridge journals a capture before it answers (runner/server/
  // events.ts: the record is appended as pending, its dispatch is recorded,
  // and only then does the response go out), so the journal can show it a
  // moment before the worker has its answer and removes the entry. A single
  // check straight away raced that (P07-B revision 3: CI run 35918588650).
  // The wait stays well inside the 30 s the worker waits before a second
  // try, so a delivery that failed still fails here.
  const checkPage = await harness.context.newPage();
  await checkPage.goto(optionsUrl());
  await expect
    .poll(
      () =>
        checkPage.evaluate(async () => {
          const all = await chrome.storage.session.get(null);
          return Object.keys(all).filter((key) => key.startsWith("jobCaptureOutbox:")).length;
        }),
      { message: "the outbox should be empty once the alarm delivered it", timeout: 10_000 },
    )
    .toBe(0);
  await checkPage.close();
});

/** Captures `fileState` at both required options widths (P07-B revision 1:
 * "retake... options at 1280 and 390"), light and dark at each -- full
 * page height throughout (pageThemeTarget's own fullPage: true), so a
 * section as far down as File bridge is never cropped out the way the
 * original 400x620 captures cropped it. Leaves the page's viewport at the
 * last width used; every caller here closes its page right after.
 *
 * P07-B revision 2, C1 and D: every state is also checked before it is
 * captured -- empty message areas take no room, `[hidden]` really hides,
 * and axe finds nothing in either theme at either width. */
async function captureOptionsBothWidths(page: Page, fileState: string): Promise<void> {
  const evaluate = (expression: string): Promise<unknown> => page.evaluate(expression);
  await expectEmptyRegionsCollapsed(evaluate, `options ${fileState}`);
  await expectHiddenReallyHidden(evaluate, `options ${fileState}`);
  for (const width of [1280, 390] as const) {
    await page.setViewportSize({ width, height: 800 });
    await expectNoSplitCommands(evaluate, `options ${fileState} (${width})`);
    const theme = pageThemeTarget(page, `options-${fileState}-${width}`);
    await inTheme(theme, "light", () => assertNoAxeViolations(evaluate, `options ${fileState} (light, ${width})`));
    await captureInTheme(theme, "light", `P07B-options-${fileState}-light-${width}.png`, screenshotPath);
    await inTheme(theme, "dark", () => assertNoAxeViolations(evaluate, `options ${fileState} (dark, ${width})`));
    await captureInTheme(theme, "dark", `P07B-options-${fileState}-dark-${width}.png`, screenshotPath);
  }
}

/** The popup counterpart of `captureOptionsBothWidths`, at the popup's
 * natural size: checked (P07-B revision 2, C1 and D -- including axe in
 * dark, which round 2 never ran against the real bridge), then captured,
 * light and dark. */
async function auditAndCapturePopup(popup: RawCdpSession, fileState: string): Promise<void> {
  const evaluate = (expression: string): Promise<unknown> => popup.evaluate(expression);
  await expectEmptyRegionsCollapsed(evaluate, `popup ${fileState}`);
  await expectHiddenReallyHidden(evaluate, `popup ${fileState}`);
  await expectNoSplitCommands(evaluate, `popup ${fileState}`);
  const popupTheme = popupThemeTarget(popup);
  await inTheme(popupTheme, "light", () => assertNoAxeViolations(evaluate, `popup ${fileState} (light)`));
  await captureInTheme(popupTheme, "light", `P07B-popup-${fileState}-light.png`, screenshotPath);
  await inTheme(popupTheme, "dark", () => assertNoAxeViolations(evaluate, `popup ${fileState} (dark)`));
  await captureInTheme(popupTheme, "dark", `P07B-popup-${fileState}-dark.png`, screenshotPath);
}

test("P07B screenshots: options page, unpaired (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
  // P07-B revision 3 polish: the inert "No capture saved yet" reads at
  // 4.5:1 or more in both themes -- a muted fill, not opacity.
  const exportButton = page.locator('[data-section="fileBridge"] button');
  await expect(exportButton).toHaveText("No capture saved yet");
  const theme = pageThemeTarget(page, "options-unpaired-inert-export");
  const evaluate = (expression: string): Promise<unknown> => page.evaluate(expression);
  for (const scheme of ["light", "dark"] as const) {
    await inTheme(theme, scheme, () => expectReadableInertButton(evaluate, '[data-section="fileBridge"] button:disabled', `options unpaired (${scheme})`));
  }
  await captureOptionsBothWidths(page, "unpaired");
  await page.close();
});

test("P07B screenshots: options page, paired with status (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);
  await captureOptionsBothWidths(page, "paired");
  await page.close();
});

test("P07B screenshots: options page, checking the runner (1280 and 390, light and dark)", async () => {
  test.setTimeout(60_000);
  // Not-paired never makes a network request at all -- bridge-client.ts's
  // own getStatus() returns a local not_paired error the instant it sees
  // no stored token (see its "or no request was attempted at all
  // (not_paired)" doc comment), so there is no in-flight GET /status to
  // hold for an unpaired page. "Checking the runner…" only exists on a
  // fresh render while paired, in the window before that real request
  // settles -- pair once via a throwaway page, then open one brand-new
  // page per width (route armed before it ever navigates there), so
  // there's never a reload/unroute race over the same page's requests.
  const pairingPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(pairingPage, code);
  await pairingPage.close();

  for (const width of [1280, 390] as const) {
    let releaseStatus: () => void = () => undefined;
    const statusHeld = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const page = await harness.context.newPage();
    // Holds GET /status open so the placeholder (B4: "Checking the
    // runner…", shown the instant the page renders, before that request
    // settles) stays up long enough to actually capture -- a real
    // loopback response normally lands in well under a millisecond,
    // faster than this state could ever otherwise be observed.
    await page.route(`${bridge.bridge.url}/status`, async (route: Route) => {
      await statusHeld;
      await route.continue();
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(optionsUrl());
    await expect(page.locator('[data-section="status"] [role="status"]')).toHaveText("Checking the runner…");

    const theme = pageThemeTarget(page, `options-checking-${width}`);
    await captureInTheme(theme, "light", `P07B-options-checking-light-${width}.png`, screenshotPath);
    await captureInTheme(theme, "dark", `P07B-options-checking-dark-${width}.png`, screenshotPath);

    releaseStatus();
    await page.close();
  }
});

test("P07B screenshots: options page, runner not running -- connection refused (1280 and 390, light and dark)", async () => {
  // P07-B revision 2, C5: revision 1 saved this state as
  // "runner-not-responding"; nothing listens on the port, so the
  // connection is refused -- "not running". The name now says so, and
  // "runner-not-responding" is the timeout state (next test).
  const page = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);

  await bridge.bridge.close();
  await page.reload();
  await expect(statusAlert(page)).toHaveText("Can't reach the runner. Is it running? Start it with npm run runner.");
  // P07-B revision 3, H1: the person has to start the runner -- amber.
  await expect(statusAlert(page)).toHaveClass("flash");

  await captureOptionsBothWidths(page, "runner-not-running");

  // Restart so afterEach's close() (already-closed is a needless risk) and
  // this file's other tests see a bridge in the state startBridgeHarness
  // always hands back (same restart gate 9's own status test already does).
  bridge.bridge = await listen(bridge.app, bridge.port);

  await page.close();
});

test("P07B screenshots: options page, runner not responding -- connected, never answers (1280 and 390, light and dark)", async () => {
  // P07-B revision 2, C5: the B4 timeout message, from a real timeout --
  // the port is held by a listener that accepts and never answers, so the
  // status request ends by the extension's own 5 s timeout.
  test.setTimeout(120_000);
  const page = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);

  await bridge.bridge.close();
  const stuck = await holdPortSilently(bridge.port);
  try {
    await page.reload();
    await expect(statusOk(page)).toHaveText("Checking the runner…");
    await expect(statusAlert(page)).toHaveText(
      "The runner isn't responding. Wait a moment and try again, or restart it with npm run runner.",
      { timeout: 15_000 },
    );
    await captureOptionsBothWidths(page, "runner-not-responding");
  } finally {
    await stuck.close();
  }

  bridge.bridge = await listen(bridge.app, bridge.port);
  await page.close();
});

test("P07B screenshots: options page, pairing expired or revoked (1280 and 390, light and dark)", async () => {
  // P07-B revision 2 polish: after the 401, Settings keeps saying the
  // pairing expired and credits npm run pair for the next code.
  const page = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);
  const deviceId = await page.evaluate(async () => {
    const stored = await chrome.storage.session.get("deviceToken");
    return (stored.deviceToken as { deviceId: string } | undefined)?.deviceId;
  });
  if (deviceId === undefined) throw new Error("expected a deviceId in chrome.storage.session after pairing, got none");
  expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);

  await page.reload();
  await expect(statusAlert(page)).toHaveText("Your pairing has expired or was revoked. Pair again above.");
  await expect(statusAlert(page)).toHaveClass("flash");
  await expect(page.locator('[data-section="pairing"] label[for]')).toHaveText("Code from npm run pair");
  // P07-B revision 3, UI issue 1 and polish: the card says what is true
  // now, in amber, and "Not paired." rather than "Not paired yet.".
  // Revision 4, K1: in the notice slot, which isn't a live region.
  const notice = page.locator('[data-section="pairing"] [data-notice]');
  await expect(notice).toHaveText("Your pairing expired or was revoked.");
  await expect(notice).toHaveClass("flash");
  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveText("");
  await expect(page.locator('[data-section="pairing"]')).toContainText("Not paired.");

  await captureOptionsBothWidths(page, "pairing-expired");
  await page.close();
});

test("P07B screenshots: options page, pairing error (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
  await page.getByLabel("Code from npm run setup").fill("ZZZZZ-ZZZZZ");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveText(
    "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run npm run pair for a new one.",
  );
  // P07-B revision 3, H1: a new code fixes it -- amber, not red.
  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveClass("flash");

  await captureOptionsBothWidths(page, "pairing-error");

  await page.close();
});

test("P07B screenshots: options page, pairing in progress (1280 and 390, light and dark)", async () => {
  // P07-B revision 3, H1 and polish: "Pairing…" is progress, so the
  // neutral edge (revision 2: amber), and Pair keeps focus while it waits
  // (aria-disabled plus a guard; revision 2's `disabled` dropped focus to
  // <body> until the runner answered). The POST /pair is held open so the
  // state lasts long enough to check and capture -- inside bridge-client's
  // 5 s request timeout, so each theme gets its own attempt, switched to
  // and settled before Pair is pressed, and each attempt is then aborted.
  test.setTimeout(90_000);
  for (const width of [1280, 390] as const) {
    const page = await harness.context.newPage();
    await page.setViewportSize({ width, height: 800 });
    // Filled by the route handler, emptied per attempt; read through a
    // function, since only the handler ever sets it.
    const held: { pair?: Route } = {};
    const heldPair = (): Route | undefined => held.pair;
    await page.route(`${bridge.bridge.url}/pair`, (route: Route) => {
      held.pair = route;
    });
    await page.goto(optionsUrl());
    await page.locator('[data-section="status"]').waitFor();
    const target = pageThemeTarget(page, `options-pairing-in-progress-${width}`);
    const evaluate = (expression: string): Promise<unknown> => page.evaluate(expression);
    const line = page.locator('[data-section="pairing"] [role="status"]');
    const pairButton = page.getByRole("button", { name: "Pair", exact: true });

    for (const theme of ["light", "dark"] as const) {
      await inTheme(target, theme, async () => undefined);
      await page.evaluate(AFTER_RESIZE_QUIET);
      delete held.pair;
      await page.getByLabel(/^Code from npm run (setup|pair)$/).fill("7KQ2M-X9RTB");
      await pairButton.click();
      await expect(line).toHaveText("Pairing…");
      await expect(line).toHaveClass("flash info");
      await expect(pairButton).toHaveAttribute("aria-disabled", "true");
      expect(await pairButton.evaluate((button) => (button as HTMLButtonElement).disabled), "never disabled: focus would drop").toBe(false);
      await expect(pairButton).toBeFocused();
      await expect.poll(() => heldPair() !== undefined).toBe(true);

      await expectEmptyRegionsCollapsed(evaluate, `options pairing-in-progress (${theme}, ${width})`);
      await expectHiddenReallyHidden(evaluate, `options pairing-in-progress (${theme}, ${width})`);
      await expectNoSplitCommands(evaluate, `options pairing-in-progress (${theme}, ${width})`);
      await assertNoAxeViolations(evaluate, `options pairing-in-progress (${theme}, ${width})`);
      await captureInTheme(target, theme, `P07B-options-pairing-in-progress-${theme}-${width}.png`, screenshotPath);

      await heldPair()?.abort();
      await expect(line).toHaveText("Can't reach the runner. Is it running? Start it with npm run runner.");
      await expect(pairButton).not.toHaveAttribute("aria-disabled", "true");
    }
    await page.close();
  }
});

test("P07B screenshots: options page, after Un-pair, then paired again in another tab (1280 and 390, light and dark)", async () => {
  // P07-B revision 3, UI issue 1, the mirror case: revision 2 kept
  // "Un-paired. You can pair again below." next to the device another tab
  // then paired. The line reports what happened on this page; once the
  // pairing it describes is gone, so is the line.
  test.setTimeout(90_000);
  const page = await openFreshOptionsPage();
  const first = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, first.code);

  await page.getByRole("button", { name: "Un-pair" }).click();
  const pairingSection = page.locator('[data-section="pairing"]');
  const line = pairingSection.locator('[role="status"]');
  await expect(line).toHaveText("Un-paired. You can pair again below.");
  await expect(line).toHaveClass("flash ok");
  await expect(pairingSection).toContainText("Not paired.");
  await expect(pairingSection).not.toContainText("Not paired yet.");
  await expect(statusOk(page)).toHaveText("Pair this browser above to see the runner's status.");
  await captureOptionsBothWidths(page, "after-unpair");

  const otherTab = await openFreshOptionsPage();
  const second = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(otherTab, second.code);
  const newDeviceId = await otherTab.evaluate(async () => {
    const stored = await chrome.storage.session.get("deviceToken");
    return (stored.deviceToken as { deviceId: string } | undefined)?.deviceId;
  });
  if (newDeviceId === undefined) throw new Error("expected the other tab's pairing in chrome.storage.session, got none");
  await otherTab.close();

  // This page learns of it on its next check.
  await page.locator('[data-section="status"] button').click();
  await expect(statusOk(page)).toContainText("Connected");
  await expect(pairingSection.locator("dl.kv dd").first()).toHaveText(`${newDeviceId.slice(0, 8)}…`);
  await expect(line, "revision 2 kept 'Un-paired.' next to the new device").toHaveText("");
  await expect(pairingSection).not.toContainText("Un-paired");
  await captureOptionsBothWidths(page, "paired-in-another-tab");
  await page.close();
});

test("P07B screenshots: popup, preview (light and dark)", async () => {
  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await auditAndCapturePopup(popup, "preview");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("P07B screenshots: popup, sent (light and dark)", async () => {
  const optionsPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(optionsPage, code);
  await optionsPage.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  expect(await waitForPopupStatus(popup, "Sent to the runner")).toEqual({ text: "Sent to the runner.", className: "flash ok" });
  // P07-B revision 3 polish: the inert "Saved ✓" reads at 4.5:1 or more
  // in both themes -- a muted fill, not opacity (revision 2: 3.99:1).
  const evaluate = (expression: string): Promise<unknown> => popup.evaluate(expression);
  const popupTheme = popupThemeTarget(popup);
  for (const scheme of ["light", "dark"] as const) {
    await inTheme(popupTheme, scheme, () => expectReadableInertButton(evaluate, 'button.primary[aria-disabled="true"]', `popup Saved ✓ (${scheme})`));
  }

  await auditAndCapturePopup(popup, "sent");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("P07B screenshots: popup, queued -- runner down (light and dark)", async () => {
  const optionsPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(optionsPage, code);
  await optionsPage.close();

  await bridge.bridge.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  // P07-B revision 3, H1: the worker retries it on its own -- the neutral
  // edge (revision 2: amber).
  expect(await waitForPopupStatus(popup, "isn't reachable right now")).toEqual({
    text: "The runner isn't reachable right now — it'll be sent automatically once it's back.",
    className: "flash info",
  });

  await auditAndCapturePopup(popup, "queued-runner-down");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();

  bridge.bridge = await listen(bridge.app, bridge.port);
});

test("P07B screenshots: popup, not paired (light and dark)", async () => {
  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  // P07-B revision 3, H1: it waits on the person pairing -- amber.
  expect(await waitForPopupStatus(popup, "Not paired yet")).toEqual({
    text: "Not paired yet — queued. It'll be sent automatically once you pair the extension in Settings.",
    className: "flash",
  });

  await auditAndCapturePopup(popup, "not-paired");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("P07B screenshots: popup, pairing expired -- 401 (light and dark)", async () => {
  const optionsPage = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(optionsPage, code);

  const deviceId = await optionsPage.evaluate(async () => {
    const stored = await chrome.storage.session.get("deviceToken");
    return (stored.deviceToken as { deviceId: string } | undefined)?.deviceId;
  });
  if (deviceId === undefined) throw new Error("expected a deviceId in chrome.storage.session after pairing, got none");
  expect(await bridge.ctx.devices.revoke(deviceId)).toBe(true);
  await optionsPage.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  // P07-B revision 3, H1: a pause waits on the person pairing again, so
  // amber (revision 2: red); red is left for a refusal nothing kept.
  expect(await waitForPopupStatus(popup, "expired or was revoked")).toEqual({
    text: "Your pairing expired or was revoked. Pair again in Settings and it's sent.",
    className: "flash",
  });

  await auditAndCapturePopup(popup, "pairing-expired");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("P07B screenshots: popup, other install -- 403 (light and dark)", async () => {
  const otherOrigin = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
  const mismatched = await pairFictionalDevice(bridge, otherOrigin);
  const seedPage = await harness.context.newPage();
  await seedPage.goto(optionsUrl());
  await seedPage.evaluate(async (token) => {
    await chrome.storage.session.set({
      deviceToken: { deviceId: token.deviceId, token: token.token, pairedAt: new Date().toISOString() },
    });
  }, mismatched);
  await seedPage.close();

  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  await focusSaveButton(popup);
  await pressEnter(popup);

  expect(await waitForPopupStatus(popup, "different install")).toEqual({
    text: "This pairing belongs to a different install. Pair again in Settings.",
    className: "flash",
  });

  await auditAndCapturePopup(popup, "other-install");

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});

test("P07B screenshots: popup, not sent -- the bridge refused it, 409 (light and dark)", async () => {
  // P07-B revision 2, C3: a capture the bridge refuses is neither sent nor
  // queued, so the popup must not say "Saved ✓". The real bridge can't be
  // driven into a refusal from a real Save -- the popup only ever sends a
  // fresh, valid capture, and every valid capture fits the bridge's body
  // cap (packages/contracts' bridge-body-size test) -- so for this one
  // state a stand-in on the bridge's port answers POST /events with the
  // bridge's own 409 envelope, word for word from runner/server/events.ts.
  const refusal = {
    ok: false,
    error: { code: "event_id_conflict", message: "This eventId was already used for a different event. Use a new eventId for a new event." },
  };
  await bridge.bridge.close();
  const standIn = await serveOnPort(bridge.port, (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": request.headers.origin ?? "*",
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type",
      });
      response.end();
      return;
    }
    request.resume();
    response.writeHead(request.url === "/events" ? 409 : 404, {
      "content-type": "application/json",
      "access-control-allow-origin": request.headers.origin ?? "*",
    });
    response.end(JSON.stringify(refusal));
  });
  try {
    const seedPage = await harness.context.newPage();
    await seedPage.goto(optionsUrl());
    await seedPage.evaluate(async () => {
      await chrome.storage.session.set({
        deviceToken: { deviceId: "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", token: "fictional-token", pairedAt: new Date().toISOString() },
      });
    });
    await seedPage.close();

    const tabPage = await harness.context.newPage();
    await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
    const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
    const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);
    expect(await waitForPopupState(popup)).toBe("preview");

    await focusSaveButton(popup);
    await pressEnter(popup);

    let statusText = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
      if (statusText.includes("refused")) break;
      await sleep(100);
    }
    // P07-B revision 3, H2: what happened and what to do next, then the
    // reason in plain words -- never the bridge's developer text ("This
    // eventId was already used…"), which revision 2 showed as it was.
    expect(statusText).toBe(
      "The runner refused this capture, so it wasn't saved. Save it as a file, or reopen the popup to capture it again. It clashes with a different capture the runner already has.",
    );
    expect(await popup.evaluate<string>(`document.querySelector('[role="status"] .detail').textContent`)).toBe(
      "It clashes with a different capture the runner already has.",
    );
    expect(await popup.evaluate<string>(`document.querySelector('[role="status"]').className`), "red: refused, and nothing kept it").toBe("flash bad");
    const button = await popup.evaluate<{ text: string; ariaDisabled: string | null; focused: boolean }>(`(() => {
      const button = document.querySelector("button.primary");
      return { text: button.textContent, ariaDisabled: button.getAttribute("aria-disabled"), focused: document.activeElement === button };
    })()`);
    expect(button, "not 'Saved ✓', and still live").toEqual({ text: "Save this job", ariaDisabled: null, focused: true });
    const queued = await popup.evaluate<number>(`chrome.storage.session.get(null).then((all) => Object.keys(all).filter((key) => key.startsWith("jobCaptureOutbox:")).length)`);
    expect(queued, "a refusal is never queued").toBe(0);

    await auditAndCapturePopup(popup, "not-sent-409");

    await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
    await popup.detach();
    await tabPage.close();
  } finally {
    await standIn.close();
  }
  bridge.bridge = await listen(bridge.app, bridge.port);
});

test("P07B screenshots: popup and options page, something other than the runner answering on its port (light and dark; options at 1280 and 390)", async () => {
  // P07-B revision 3, H2 and H4: another program holds the runner's port
  // and answers every request with a web page. The popup queues the capture
  // for the worker to retry, in the neutral tone; Settings says the same
  // thing in one sentence with a next step -- in Status, and in the outbox
  // line below it -- and keeps the pairing (nothing refused the token).
  // Revision 2's Status blamed the runner, in jargon ("didn't match the
  // expected shape", "HTTP 404").
  test.setTimeout(90_000);
  await bridge.bridge.close();
  const foreign = await serveOnPort(bridge.port, (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Another program</title><p>A fictional local dev server.</p>");
  });
  try {
    const storagePage = await openQuietStoragePage();
    await storeFictionalPairing(storagePage, "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", "fictional-token");
    await storagePage.close();

    const tabPage = await harness.context.newPage();
    await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
    const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
    const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);
    expect(await waitForPopupState(popup)).toBe("preview");
    await focusSaveButton(popup);
    await pressEnter(popup);

    expect(await waitForPopupStatus(popup, "Something other than the runner")).toEqual({
      text: "Something other than the runner is answering on its port — queued. It'll be sent once the runner answers.",
      className: "flash info",
    });
    await auditAndCapturePopup(popup, "queued-foreign-server");
    await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
    await popup.detach();
    await tabPage.close();

    const page = await openFreshOptionsPage();
    await expect(statusAlert(page)).toHaveText(
      "Something other than the runner is answering on its port. Close that program, then start the runner with npm run runner.",
    );
    await expect(statusAlert(page)).toHaveClass("flash");
    await expect(statusAlert(page).locator("code")).toHaveText("npm run runner");
    // Revision 4, K3: the outbox line doesn't repeat the alert's clause.
    await expect(page.locator('[data-section="status"]')).toContainText("1 saved job waiting to send; trying again.");
    expect(
      ((await page.locator('[data-section="status"]').textContent()) ?? "").split("Something other than the runner is answering on its port"),
      "said once, by the alert",
    ).toHaveLength(2);
    await expect(page.locator('[data-section="status"]')).not.toContainText(/HTTP|shape/);
    await expect(page.locator('[data-section="pairing"]'), "nothing refused the token").toContainText("8b0c6f0e");
    await captureOptionsBothWidths(page, "foreign-server");
    await page.close();
  } finally {
    await foreign.close();
  }
  bridge.bridge = await listen(bridge.app, bridge.port);
});

test("P07B screenshots: popup, queued -- this browser was paired again while it saved (light and dark)", async () => {
  // P07-B revision 3, H4: the token_replaced state (bridge-client.ts). A
  // stand-in on the bridge's port answers every POST /events 401 in the
  // bridge's own envelope, but first moves this browser on to a newer
  // pairing -- the way a re-pair in Settings can land while a Save is in
  // flight. Both the Save and bridge-client's one retry with the newer
  // token come back refused for a token already replaced, so the capture
  // is queued for retry (neutral), not paused. The real bridge can't be
  // re-paired twice inside one request. Tokens are swapped from the side
  // panel page, which (unlike Settings) runs no status check of its own.
  const storagePage = await openQuietStoragePage();
  await storeFictionalPairing(storagePage, "8b0c6f0e-2f1a-4c55-9d3e-0a1b2c3d4e5f", "fictional-token-1");
  const newerPairings = [
    { deviceId: "9c1d7a1f-3a2b-4d66-8e4f-1b2c3d4e5f60", token: "fictional-token-2" },
    { deviceId: "0d2e8b20-4b3c-4e77-9f50-2c3d4e5f6071", token: "fictional-token-3" },
  ];
  const tokenInvalid = {
    ok: false,
    error: { code: "token_invalid", message: "This device token is not valid (unknown, revoked or expired). Pair the extension again." },
  };
  await bridge.bridge.close();
  const standIn = await serveOnPort(bridge.port, (request, response) => {
    request.resume();
    void (async () => {
      const newer = request.method === "POST" ? newerPairings.shift() : undefined;
      if (newer) await storeFictionalPairing(storagePage, newer.deviceId, newer.token);
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify(tokenInvalid));
    })();
  });
  try {
    const tabPage = await harness.context.newPage();
    await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
    const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
    const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);
    expect(await waitForPopupState(popup)).toBe("preview");
    await focusSaveButton(popup);
    await pressEnter(popup);

    expect(await waitForPopupStatus(popup, "paired again")).toEqual({
      text: "Queued — this browser was just paired again. It'll be sent shortly.",
      className: "flash info",
    });
    expect(newerPairings, "both requests reached the stand-in").toEqual([]);
    const entry = await popup.evaluate<{ lastErrorCode?: string; pausedReason?: string } | undefined>(
      `chrome.storage.session.get(null).then((all) => Object.entries(all).find(([key]) => key.startsWith("jobCaptureOutbox:"))?.[1])`,
    );
    expect(entry?.lastErrorCode).toBe("token_replaced");
    expect(entry?.pausedReason, "queued for retry, not paused").toBeUndefined();

    await auditAndCapturePopup(popup, "queued-token-replaced");

    await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
    await popup.detach();
    await tabPage.close();
  } finally {
    await standIn.close();
    await storagePage.close();
  }
  bridge.bridge = await listen(bridge.app, bridge.port);
});

test("Settings: 'Export last capture' exports the capture the popup just saved (P07-B revision 2, D)", async () => {
  // Save hands its capture to Settings (storage.session's lastJobCapture)
  // whatever happens to it next; here nothing is paired, so the popup
  // queues it. Exporting it from Settings must still produce the real file.
  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);
  expect(await waitForPopupState(popup)).toBe("preview");
  await focusSaveButton(popup);
  await pressEnter(popup);
  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("Not paired yet")) break;
    await sleep(100);
  }
  expect(statusText).toBe("Not paired yet — queued. It'll be sent automatically once you pair the extension in Settings.");
  const savedEventId = await popup.evaluate<string | undefined>(`chrome.storage.session.get("lastJobCapture").then((stored) => stored.lastJobCapture?.eventId)`);
  expect(savedEventId).toBeTruthy();
  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();

  const page = await openFreshOptionsPage();
  const exportButton = page.getByRole("button", { name: "Export last capture" });
  await expect(exportButton).toBeEnabled();
  const exported = path.join(downloadDir, "job-capture.json");
  rmSync(exported, { force: true });
  await exportButton.click();
  await expect(page.locator('[data-section="fileBridge"] [role="status"]')).toHaveText("Exported job-capture.json.");
  const capture = JSON.parse(await waitForDownload(downloadDir, "job-capture.json")) as JobCapture;
  expect(capture.eventId).toBe(savedEventId);
  expect(capture.type).toBe("job_capture");
  expect(capture.url).toBe(`${fixtureServer.origin}/posting-json-ld.html`);
  rmSync(exported);
  await page.close();
});
