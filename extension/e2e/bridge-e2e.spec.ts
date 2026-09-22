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
 *   - the P07B acceptance screenshots (docs/screenshots/P07B-*.png):
 *     options paired, options pairing-error, and popup saved, each light
 *     and dark, via theme-capture.ts's captureInTheme (shared with
 *     real-popup.spec.ts's own P07A screenshots) -- opt-in writes gated on
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
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page, Route } from "@playwright/test";
import { DEVICE_TOKEN_TTL_MS } from "@workflow-catalog/runner/store/devices.ts";
import { listen } from "@workflow-catalog/runner/server/app.ts";
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
  type RealPopupHarness,
} from "./real-popup-cdp";
import {
  cleanScratchWorkspaces,
  pairFictionalDevice,
  startBridgeHarness,
  type BridgeHarness,
} from "./real-bridge-harness";
import { captureInTheme, pageThemeTarget, popupThemeTarget } from "./theme-capture";

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
  bridge = await startBridgeHarness();
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
 * `bridge`, a real re-render on the response. */
async function pairThroughTheRealForm(page: Page, code: string): Promise<void> {
  await page.getByLabel("Code from npm run setup").fill(code);
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
  const checkPage = await harness.context.newPage();
  await checkPage.goto(optionsUrl());
  const stillQueued = await checkPage.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.keys(all).filter((key) => key.startsWith("jobCaptureOutbox:")).length;
  });
  expect(stillQueued, "the outbox should be empty once the alarm delivered it").toBe(0);
  await checkPage.close();
});

/** Captures `fileState` at both required options widths (P07-B revision 1:
 * "retake... options at 1280 and 390"), light and dark at each -- full
 * page height throughout (pageThemeTarget's own fullPage: true), so a
 * section as far down as File bridge is never cropped out the way the
 * original 400x620 captures cropped it. Leaves the page's viewport at the
 * last width used; every caller here closes its page right after. */
async function captureOptionsBothWidths(page: Page, fileState: string): Promise<void> {
  for (const width of [1280, 390] as const) {
    await page.setViewportSize({ width, height: 800 });
    const theme = pageThemeTarget(page, `options-${fileState}-${width}`);
    await captureInTheme(theme, "light", `P07B-options-${fileState}-light-${width}.png`, screenshotPath);
    await captureInTheme(theme, "dark", `P07B-options-${fileState}-dark-${width}.png`, screenshotPath);
  }
}

test("P07B screenshots: options page, unpaired (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
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

test("P07B screenshots: options page, runner not responding (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
  const { code } = await bridge.ctx.pairing.issue();
  await pairThroughTheRealForm(page, code);

  await bridge.bridge.close();
  await page.reload();
  await expect(statusAlert(page)).toHaveText("Can't reach the runner. Is it running? Start it with npm run runner.");

  await captureOptionsBothWidths(page, "runner-not-responding");

  // Restart so afterEach's close() (already-closed is a needless risk) and
  // this file's other tests see a bridge in the state startBridgeHarness
  // always hands back (same restart gate 9's own status test already does).
  bridge.bridge = await listen(bridge.app, bridge.port);

  await page.close();
});

test("P07B screenshots: options page, pairing error (1280 and 390, light and dark)", async () => {
  const page = await openFreshOptionsPage();
  await page.getByLabel("Code from npm run setup").fill("ZZZZZ-ZZZZZ");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.locator('[data-section="pairing"] [role="status"]')).toHaveText(
    "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run npm run pair for a new one.",
  );

  await captureOptionsBothWidths(page, "pairing-error");

  await page.close();
});

test("P07B screenshots: popup, preview (light and dark)", async () => {
  const tabPage = await harness.context.newPage();
  await tabPage.goto(`${fixtureServer.origin}/posting-json-ld.html`);
  const tabTargetId = await getTabTargetId(harness.bs, harness.context, tabPage);
  const popup = await triggerRealPopup(harness.bs, harness.extId, tabTargetId);

  const state = await waitForPopupState(popup);
  expect(state).toBe("preview");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-preview-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-preview-dark.png", screenshotPath);

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

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("Sent to the runner")) break;
    await sleep(100);
  }
  expect(statusText).toBe("Sent to the runner.");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-sent-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-sent-dark.png", screenshotPath);

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

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("isn't reachable right now")) break;
    await sleep(100);
  }
  expect(statusText).toBe("The runner isn't reachable right now — it'll be sent automatically once it's back.");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-queued-runner-down-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-queued-runner-down-dark.png", screenshotPath);

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

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("Not paired yet")) break;
    await sleep(100);
  }
  expect(statusText).toBe("Not paired yet — queued. It'll be sent automatically once you pair the extension in Settings.");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-not-paired-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-not-paired-dark.png", screenshotPath);

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

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("expired or was revoked")) break;
    await sleep(100);
  }
  expect(statusText).toBe("Your pairing expired or was revoked. Pair again in Settings and it's sent.");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-pairing-expired-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-pairing-expired-dark.png", screenshotPath);

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

  let statusText = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusText = await popup.evaluate<string>(`document.querySelector('[role="status"]').textContent`);
    if (statusText.includes("different install")) break;
    await sleep(100);
  }
  expect(statusText).toBe("This pairing belongs to a different install. Pair again in Settings.");

  const popupTheme = popupThemeTarget(popup);
  await captureInTheme(popupTheme, "light", "P07B-popup-other-install-light.png", screenshotPath);
  await captureInTheme(popupTheme, "dark", "P07B-popup-other-install-dark.png", screenshotPath);

  await harness.bs.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => undefined);
  await popup.detach();
  await tabPage.close();
});
