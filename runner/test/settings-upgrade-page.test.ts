import { describe, expect, it } from "vitest";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { createUpgradeRouteModule } from "../server/routes/upgrade.ts";
import { makeBridge, type TestBridge } from "./helpers.ts";
import { openUiPage } from "./page-harness.ts";
import { fakeUpgradeDeps } from "./upgrade-fixtures.ts";

/**
 * F11 (gate review round 1, reclassified BLOCKING; round 2 asks for a page
 * test, not only the route-level ones in upgrade-route.test.ts and
 * upgrade-core.test.ts): the Settings page's Upgrade section
 * (`ui/settings.html` + `ui/assets/settings-upgrade.js`), run in a real DOM
 * (happy-dom, `page-harness.ts` — the technique of `sessions-page.test.ts`
 * and `board-page.test.ts`) against the real route. Only `settings-upgrade.js`
 * is imported (`script: "settings-upgrade"`): `settings-budget.js` and
 * `settings-schedules.js` would each fire their own request to a route this
 * test never registers, which is irrelevant noise for what this test checks
 * (`page.requests` only ever records what actually ran, so those two never
 * appearing here is itself part of the proof this test is written for).
 */
function bridgeWith(deps: ReturnType<typeof fakeUpgradeDeps>): Promise<TestBridge> {
  const modules: readonly LoadedRouteModule[] = [{ name: "upgrade", module: createUpgradeRouteModule(deps) }];
  return makeBridge({ modules });
}

describe("the Settings page's Upgrade section: what a load requests, versus a check", () => {
  it("loading the page requests only /api/upgrade/status; only pressing Check for updates requests /api/upgrade", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    const page = await openUiPage(bridge, {
      page: "settings",
      script: "settings-upgrade",
      liveRegionId: "status-message",
      ready: (document) => document.getElementById("upgrade-current-value")?.textContent === "0.1.0",
    });

    // The load: exactly one request, to /status -- never the release-lookup path, and never more than once.
    expect(page.requests).toEqual(["GET /api/upgrade/status"]);

    page.press("upgrade-check");
    await page.quiet();

    // The check: adds exactly one more request, to the release lookup -- the /status request from load is still
    // the only earlier one, so this also proves the check did not itself repeat the status read.
    expect(page.requests).toEqual(["GET /api/upgrade/status", "GET /api/upgrade"]);
  });
});
