import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, extensionDist, test } from "./fixtures";

test.beforeAll(() => {
  if (!existsSync(extensionDist)) {
    throw new Error(`extension/dist not found — run "pnpm --filter @workflow-catalog/extension build" first.`);
  }
});

/**
 * Review issue 4: the old "no CSP violations" test attached a
 * `context.on("weberror")` listener after the context had already
 * launched and never navigated any page itself — with nothing to ever
 * generate an error, it passed vacuously (proven by the reviewer: an
 * emptied theme.css plus a planted `new Function` in dist still passed
 * 4/4). This is attached to a specific page BEFORE that page navigates
 * (`page.addInitScript` runs before any of the page's own scripts, and
 * the `pageerror`/`console` listeners are registered before `goto`), and
 * is asserted against in every one-of-three-pages test below, so a real
 * violation on any of them fails that test.
 *
 * Three independent signals, because no single one covers every kind of
 * CSP violation:
 *   - `securitypolicyviolation` is the DOM event the CSP spec guarantees
 *     fires for every blocked resource/script/style, independent of
 *     whether the browser also happens to log it to the console.
 *   - `pageerror` catches a blocked `eval`/`new Function` call throwing a
 *     synchronous, uncaught exception at the call site (MV3's default
 *     extension-pages CSP blocks both; calling either throws rather than
 *     silently no-op'ing).
 *   - `console` (type "error") is a broad net for anything Chrome reports
 *     to the console that the other two don't structurally guarantee.
 */
function watchForBrowserErrors(page: Page): { assertNone: () => Promise<void> } {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  return {
    assertNone: async () => {
      const cspViolations = await page.evaluate(
        () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
      );
      expect(cspViolations, "no securitypolicyviolation events fired").toEqual([]);
      expect(pageErrors, "no uncaught page errors (e.g. a CSP-blocked eval/Function throwing)").toEqual([]);
      expect(consoleErrors, "no console errors").toEqual([]);
    },
  };
}

/** Must be called before `page.goto`, pairs with `watchForBrowserErrors`'s
 * `securitypolicyviolation` read above. `addInitScript` runs before any
 * script on the page itself, on every navigation, so this is armed before
 * the page has a chance to violate anything. */
async function recordCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
        `${event.violatedDirective}: blocked ${event.blockedURI || "(inline)"}`,
      );
    });
  });
}

/**
 * Review issue 4: "assert `document.fonts.check('12px Geist')` and that
 * body background equals the `--background` token" instead of the old
 * `expect(backgroundColor).not.toBe("")`, which is true even for an empty
 * string compared to an empty string and would pass no matter what
 * theme.css contained (or if it 404'd entirely).
 *
 * Comparing body's resolved background to a probe element whose
 * background-color is literally `var(--background)` (rather than to a
 * hard-coded color string) means this doesn't need to know or maintain
 * the token's current oklch() value or how Chrome happens to serialize
 * it back out of getComputedStyle — it only needs the two to resolve to
 * the *same* computed value, which is exactly what "theme.css loaded and
 * applied" means. The `toMatch` below guards against the vacuous
 * empty-string-equals-empty-string case the old assertion missed: an
 * empty background never matches that pattern, so a totally missing
 * theme.css fails loudly again.
 */
async function assertThemeAndFontsLoaded(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  const fontLoaded = await page.evaluate(() => document.fonts.check("12px Geist"));
  expect(fontLoaded, "Geist should be loaded via the self-hosted woff2, not falling back silently").toBe(true);

  const { bodyBackground, tokenBackground } = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.appendChild(probe);
    const tokenBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { bodyBackground: getComputedStyle(document.body).backgroundColor, tokenBackground };
  });
  expect(bodyBackground).toMatch(/^(rgb|rgba|oklch|color)\(/);
  expect(bodyBackground, "body background should equal the --background token, not the UA default").toBe(tokenBackground);
}

test("the extension loads and its service worker starts", async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test("the options page renders (pairing + file bridge sections, real fonts/theme applied, no CSP violations)", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  await recordCspViolations(page);
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);

  await expect(page.getByRole("heading", { name: "Job Assistant" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pairing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "File bridge" })).toBeVisible();
  await expect(page.getByText("Not paired yet.")).toBeVisible();
  await expect(page.getByText("Code from npm run setup")).toBeVisible();

  await assertThemeAndFontsLoaded(page);
  await errors.assertNone();

  await page.close();
});

// Renamed (review issue 4): this does not open a page at a chrome:// URL —
// it opens the popup itself directly (chrome-extension://.../popup/index.html),
// the same way every other test in this file opens an extension page.
// `chrome.tabs.query` for the (real) active tab still resolves a Tab
// object, but *without* a genuine user-gesture activeTab grant (a direct
// page navigation to the popup's URL isn't one — see popup/main.ts and
// browser-boundary.md), Chrome omits the sensitive `url` field from it.
// `!tab.url` is what actually fires here, not the `explainUnsupportedUrl`
// scheme check (that would need a *readable* chrome:// URL to even run;
// this never gets one). The real-popup.spec.ts file in this same
// directory exercises explainUnsupportedUrl's scheme-specific branches
// (and the popup's successful-extraction path) using a genuine gesture
// via Extensions.triggerAction, which this test intentionally does not.
test("the popup, opened without a genuine activeTab grant, shows the no-readable-address fallback (not a scheme-specific refusal)", async ({
  context,
  extensionId,
}) => {
  const [initialPage] = context.pages();
  if (initialPage) {
    await initialPage.bringToFront();
  }

  const popup = await context.newPage();
  const errors = watchForBrowserErrors(popup);
  await recordCspViolations(popup);
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);

  await expect(popup.getByText("Job Assistant")).toBeVisible();
  await expect(popup.getByText("Can't read this page — it has no readable address.")).toBeVisible({ timeout: 10_000 });
  await expect(popup.getByText("http://127.0.0.1:4310/ui/jobs.html")).toBeVisible();

  await assertThemeAndFontsLoaded(popup);
  await errors.assertNone();

  await popup.close();
});

test("the side panel placeholder renders (real fonts/theme applied, no CSP violations)", async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = watchForBrowserErrors(page);
  await recordCspViolations(page);
  await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);

  await expect(page.getByText("Job Assistant")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Coming soon" })).toBeVisible();

  await assertThemeAndFontsLoaded(page);
  await errors.assertNone();

  await page.close();
});
