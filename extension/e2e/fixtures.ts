/**
 * Loads the *built* extension (extension/dist/ — run `pnpm build` first)
 * into a persistent Chromium context, the way Playwright's own docs
 * require for testing Chrome extensions: "Extensions only work in Chrome /
 * Chromium launched with a persistent context." Branded Chrome/Edge
 * removed the command-line extension-sideloading flags this depends on
 * (`--load-extension`), which is exactly why this runs on Playwright's
 * bundled Chromium rather than a system browser (browser-boundary.md:
 * "Playwright docs instruct using bundled Chromium because branded
 * Chrome/Edge removed command-line extension side-loading flags").
 *
 * `channel: "chromium"` is required, not cosmetic. Playwright's launcher
 * picks between two separate downloaded binaries based on the `headless`
 * option alone (playwright-core, `getExecutableName`):
 * `headless ? "chromium-headless-shell" : "chromium"`. `chromium-headless-shell`
 * is a stripped binary (Chrome's own "old headless" shell) with no
 * extensions subsystem at all — `--load-extension` against it loads
 * nothing and starts no service worker, silently (confirmed directly: CDP
 * `Target.getTargets` against a context launched that way showed a single
 * blank page and nothing else, not even Chromium's own internal helper
 * extensions). Setting `channel: "chromium"` short-circuits that
 * headless-based choice (`registry.isChromiumAlias(options.channel)`) and
 * forces the full `Google Chrome for Testing` binary, which supports
 * extensions under `--headless=new` (the mode Playwright's own
 * `headless: true` maps to for that binary).
 */
import { test as base, chromium, type BrowserContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDist = path.resolve(here, "../dist");

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires destructuring the (unused) fixtures object
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "wc-extension-pw-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: "chromium",
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    // This Chrome-for-Testing build also runs its own internal helper
    // extensions (observed service workers named thunk.js/background.js)
    // alongside ours -- filter for the one running *this* extension's
    // worker.js specifically, not just "any" service worker.
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
    const url = new URL(worker.url());
    await use(url.host);
  },
});

export const expect = test.expect;
