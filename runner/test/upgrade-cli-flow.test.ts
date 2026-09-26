import { describe, expect, it } from "vitest";
import { newWorkspace } from "./helpers.ts";
import { buildReleaseTarball, fakeUpgradeDeps } from "./upgrade-fixtures.ts";
import { runUpgradeCli } from "../upgrade/cli-flow.ts";
import { currentWorkspaceVersion } from "../upgrade/upgrade.ts";

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

function refuseIfAsked() {
  return async () => {
    throw new Error("upgrade-cli-flow.test: ask() must never be called here");
  };
}

describe("runUpgradeCli (B1a: the CLI's own confirmation, previously untested)", () => {
  it("up_to_date: never asks, never applies", async () => {
    const workspace = await newWorkspace();
    const outcome = await runUpgradeCli(workspace, { ...fakeUpgradeDeps(undefined), yes: false, isTTY: true, ask: refuseIfAsked() });
    expect(outcome).toEqual({ kind: "up_to_date", currentVersion: "0.1.0" });
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it('a "no" answer changes nothing: the workspace stays on its old version', async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    const outcome = await runUpgradeCli(workspace, { ...fakeUpgradeDeps({ version: "0.2.0", tarball }), yes: false, isTTY: true, ask: async () => false });
    expect(outcome).toEqual({ kind: "declined" });
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
    expect(await workspace.readJson("career-profile.json").catch(() => undefined)).toBeUndefined();
  });

  it("B1a: a non-interactive run without --yes refuses to ask, and changes nothing -- ask is never even called", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    const outcome = await runUpgradeCli(workspace, { ...fakeUpgradeDeps({ version: "0.2.0", tarball }), yes: false, isTTY: false, ask: refuseIfAsked() });
    expect(outcome.kind).toBe("confirmation_unavailable");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
    expect(await workspace.readJson("career-profile.json").catch(() => undefined)).toBeUndefined();
  });

  it("--yes applies without ever calling ask", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    const outcome = await runUpgradeCli(workspace, { ...fakeUpgradeDeps({ version: "0.2.0", tarball }), yes: true, isTTY: false, ask: refuseIfAsked() });
    expect(outcome.kind).toBe("applied");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.2.0");
  });

  it('an interactive "yes" (ask resolves true) applies the upgrade', async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    let askedFor: string | undefined;
    const outcome = await runUpgradeCli(workspace, {
      ...fakeUpgradeDeps({ version: "0.2.0", tarball }),
      yes: false,
      isTTY: true,
      ask: async (nextVersion) => {
        askedFor = nextVersion;
        return true;
      },
    });
    expect(askedFor).toBe("0.2.0");
    expect(outcome.kind).toBe("applied");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.2.0");
  });

  it("a refused check (missing_asset) never reaches ask or applyUpgrade", async () => {
    const workspace = await newWorkspace();
    const deps = {
      resolve: async () => [{ address: "203.0.113.10", family: 4 as const }],
      performRequest: async (input: { readonly url: URL }) => {
        if (input.url.hostname === "api.github.com") {
          return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ tag_name: "job-assistant@0.2.0", body: "", assets: [] }), "utf8") };
        }
        throw new Error("must not download");
      },
    };
    const outcome = await runUpgradeCli(workspace, { ...deps, yes: true, isTTY: false, ask: refuseIfAsked() });
    expect(outcome).toEqual({ kind: "check_refused", nextVersion: "0.2.0", message: expect.any(String) });
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });
});
