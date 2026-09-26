import { describe, expect, it } from "vitest";
import { createUpgradeRouteModule } from "../server/routes/upgrade.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { currentWorkspaceVersion } from "../upgrade/upgrade.ts";
import { BRIDGE, UI_TOKEN, makeBridge } from "./helpers.ts";
import { buildReleaseTarball, fakeUpgradeDeps, networkForbiddenDeps, sha256Line } from "./upgrade-fixtures.ts";

const COOKIE = `wc_runner_ui=${UI_TOKEN}`;
const READ = { cookie: COOKIE, "sec-fetch-site": "same-origin" };
const SAME_ORIGIN = { cookie: COOKIE, origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };

function workflowManifest(version: string) {
  return {
    name: "job-assistant",
    version,
    description: "Fictional test manifest.",
    requiredSources: [],
    connections: ["pasted_text"],
    browserPermissions: [],
    actions: [],
    schemas: [],
    adapters: ["eve"],
    changelog: [{ version, date: "2026-09-25", notes: [`Release ${version}.`] }],
  };
}

async function bridgeWith(deps: ReturnType<typeof fakeUpgradeDeps>) {
  const modules: readonly LoadedRouteModule[] = [{ name: "upgrade", module: createUpgradeRouteModule(deps) }];
  return makeBridge({ modules });
}

/** A release whose asset list is missing the expected names -- a `refused` GET reachable without any download (F11: a check never downloads). */
function releaseMissingAssets(): ReturnType<typeof fakeUpgradeDeps> {
  return {
    resolve: async () => [{ address: "203.0.113.10", family: 4 as const }],
    performRequest: async (input) => {
      if (input.url.hostname === "api.github.com") {
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ tag_name: "job-assistant@0.2.0", body: "", assets: [] }), "utf8") };
      }
      throw new Error("upgrade-route.test: a check must never download an asset");
    },
  };
}

describe("GET /api/upgrade/status", () => {
  it("F11: reports the workspace's current version and makes no network request at all -- proved with deps that throw on any request", async () => {
    const modules: readonly LoadedRouteModule[] = [{ name: "upgrade", module: createUpgradeRouteModule(networkForbiddenDeps) }];
    const bridge = await makeBridge({ modules });
    const response = await bridge.request("/api/upgrade/status", { headers: READ });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ currentVersion: "0.1.0" });
  });

  it("401 without the sign-in cookie, 403 cross-site (the local-UI guard, same as every other route)", async () => {
    const modules: readonly LoadedRouteModule[] = [{ name: "upgrade", module: createUpgradeRouteModule(networkForbiddenDeps) }];
    const bridge = await makeBridge({ modules });
    expect((await bridge.request("/api/upgrade/status")).status).toBe(401);
    expect((await bridge.request("/api/upgrade/status", { headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
});

describe("GET /api/upgrade", () => {
  it("401 without the sign-in cookie, 403 cross-site (the local-UI guard, same as every other route)", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    expect((await bridge.request("/api/upgrade")).status).toBe(401);
    expect((await bridge.request("/api/upgrade", { headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("up_to_date with the workspace's current version when there is no release", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "up_to_date", currentVersion: "0.1.0" });
  });

  it("available, with the release's own notes as the changelog, for a genuinely newer release", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith(fakeUpgradeDeps({ version: "0.2.0", tarball, notes: "Adds upgrades." }));
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; currentVersion: string; nextVersion: string; releaseNotes: string };
    expect(body).toEqual({ status: "available", currentVersion: "0.1.0", nextVersion: "0.2.0", releaseNotes: "Adds upgrades." });
  });

  it("refused (200, ok: false shape from checkResponse) with a plain message when the release is missing its assets -- reachable from the check alone, no download", async () => {
    const bridge = await bridgeWith(releaseMissingAssets());
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason: string };
    expect(body.status).toBe("refused");
    expect(body.reason).toBe("missing_asset");
  });

  it("B1a: repeated GETs while a release is available never apply it -- workspace.json (read fresh off disk) stays at the old version, with no migration run", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith(fakeUpgradeDeps({ version: "0.2.0", tarball }));

    for (let i = 0; i < 5; i += 1) {
      const response = await bridge.request("/api/upgrade", { headers: READ });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("available"); // the fixture never changes, so every single GET must see the same thing
    }

    expect(await currentWorkspaceVersion(bridge.workspace)).toBe("0.1.0");
    expect(await bridge.workspace.readJson("career-profile.json").catch(() => undefined)).toBeUndefined(); // the 0.2.0 migration never ran
  });
});

describe("POST /api/upgrade/confirm", () => {
  it("401 without the cookie (same-origin, so the guard reaches the cookie check), 403 cross-site", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    const noCookie = { origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    expect((await bridge.request("/api/upgrade/confirm", { method: "POST", headers: noCookie, body: "{}" })).status).toBe(401);
    const crossSite = { ...SAME_ORIGIN, "sec-fetch-site": "cross-site" };
    expect((await bridge.request("/api/upgrade/confirm", { method: "POST", headers: crossSite, body: "{}" })).status).toBe(403);
  });

  it("applies a confirmed upgrade and returns the new version", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith(fakeUpgradeDeps({ version: "0.2.0", tarball }));
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; fromVersion: string; toVersion: string; ranSteps: unknown[] };
    expect(body).toMatchObject({ status: "upgraded", fromVersion: "0.1.0", toVersion: "0.2.0" });

    const after = await bridge.request("/api/upgrade", { headers: READ });
    expect(await after.json()).toEqual({ status: "up_to_date", currentVersion: "0.2.0" });
    expect(await currentWorkspaceVersion(bridge.workspace)).toBe("0.2.0");
  });

  it("409s a stale confirmation (the caller's nextVersion no longer matches what is actually available), and changes nothing on disk", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith(fakeUpgradeDeps({ version: "0.2.0", tarball }));
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.3.0" }) });
    expect(response.status).toBe(409);
    expect(await currentWorkspaceVersion(bridge.workspace)).toBe("0.1.0");
  });

  it("409s when there is nothing to confirm", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(409);
  });

  it("422s a refused (checksum mismatch) confirmation with a plain message, never a raw exception", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("wrong"), "job-assistant-0.2.0.tgz"), "utf8");
    const bridge = await bridgeWith(fakeUpgradeDeps({ version: "0.2.0", tarball, checksumBytes: wrongChecksum }));
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("checksum_mismatch");
    expect(typeof body.error.message).toBe("string");
    expect(await currentWorkspaceVersion(bridge.workspace)).toBe("0.1.0");
  });

  it("400s a malformed body", async () => {
    const bridge = await bridgeWith(fakeUpgradeDeps(undefined));
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });
});
