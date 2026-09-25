import { describe, expect, it } from "vitest";
import { createUpgradeRouteModule } from "../server/routes/upgrade.ts";
import type { LoadedRouteModule } from "../server/route-modules.ts";
import { BRIDGE, UI_TOKEN, makeBridge } from "./helpers.ts";
import { buildReleaseTarball, fakeUpgradeDeps, sha256Line } from "./upgrade-fixtures.ts";

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

async function bridgeWith(release: Parameters<typeof fakeUpgradeDeps>[0]) {
  const modules: readonly LoadedRouteModule[] = [{ name: "upgrade", module: createUpgradeRouteModule(fakeUpgradeDeps(release)) }];
  return makeBridge({ modules });
}

describe("GET /api/upgrade", () => {
  it("401 without the sign-in cookie, 403 cross-site (the local-UI guard, same as every other route)", async () => {
    const bridge = await bridgeWith(undefined);
    expect((await bridge.request("/api/upgrade")).status).toBe(401);
    expect((await bridge.request("/api/upgrade", { headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("up_to_date with the workspace's current version when there is no release", async () => {
    const bridge = await bridgeWith(undefined);
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "up_to_date", currentVersion: "0.1.0" });
  });

  it("available, with the changelog, for a genuinely newer release", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith({ version: "0.2.0", tarball, notes: "Adds upgrades." });
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; currentVersion: string; nextVersion: string; changelog: unknown[] };
    expect(body).toMatchObject({ status: "available", currentVersion: "0.1.0", nextVersion: "0.2.0" });
    expect(body.changelog).toEqual([{ version: "0.2.0", date: "2026-09-25", notes: ["Release 0.2.0."] }]);
  });

  it("refused (200, ok: false shape from checkResponse) with a plain message for a checksum mismatch", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("wrong"), "job-assistant-0.2.0.tgz"), "utf8");
    const bridge = await bridgeWith({ version: "0.2.0", tarball, checksumBytes: wrongChecksum });
    const response = await bridge.request("/api/upgrade", { headers: READ });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason: string };
    expect(body.status).toBe("refused");
    expect(body.reason).toBe("checksum_mismatch");
  });
});

describe("POST /api/upgrade/confirm", () => {
  it("401 without the cookie (same-origin, so the guard reaches the cookie check), 403 cross-site", async () => {
    const bridge = await bridgeWith(undefined);
    const noCookie = { origin: BRIDGE, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    expect((await bridge.request("/api/upgrade/confirm", { method: "POST", headers: noCookie, body: "{}" })).status).toBe(401);
    const crossSite = { ...SAME_ORIGIN, "sec-fetch-site": "cross-site" };
    expect((await bridge.request("/api/upgrade/confirm", { method: "POST", headers: crossSite, body: "{}" })).status).toBe(403);
  });

  it("applies a confirmed upgrade and returns the new version", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith({ version: "0.2.0", tarball });
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; fromVersion: string; toVersion: string; ranSteps: unknown[] };
    expect(body).toMatchObject({ status: "upgraded", fromVersion: "0.1.0", toVersion: "0.2.0" });

    const after = await bridge.request("/api/upgrade", { headers: READ });
    expect(await after.json()).toEqual({ status: "up_to_date", currentVersion: "0.2.0" });
  });

  it("409s a stale confirmation (the caller's nextVersion no longer matches what is actually available), and changes nothing", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const bridge = await bridgeWith({ version: "0.2.0", tarball });
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.3.0" }) });
    expect(response.status).toBe(409);
    expect(bridge.workspace.manifest.packageVersion).toBe("0.1.0");
  });

  it("409s when there is nothing to confirm", async () => {
    const bridge = await bridgeWith(undefined);
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(409);
  });

  it("422s a refused (checksum mismatch) confirmation with a plain message, never a raw exception", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("wrong"), "job-assistant-0.2.0.tgz"), "utf8");
    const bridge = await bridgeWith({ version: "0.2.0", tarball, checksumBytes: wrongChecksum });
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({ nextVersion: "0.2.0" }) });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("checksum_mismatch");
    expect(typeof body.error.message).toBe("string");
  });

  it("400s a malformed body", async () => {
    const bridge = await bridgeWith(undefined);
    const response = await bridge.request("/api/upgrade/confirm", { method: "POST", headers: SAME_ORIGIN, body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });
});
