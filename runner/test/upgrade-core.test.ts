import { describe, expect, it } from "vitest";
import { newWorkspace } from "./helpers.ts";
import { buildReleaseTarball, fakeUpgradeDeps, networkForbiddenDeps, sha256Line } from "./upgrade-fixtures.ts";
import { applyUpgrade, checkForUpgrade, currentWorkspaceVersion } from "../upgrade/upgrade.ts";

function workflowManifest(version: string, notes: readonly string[] = [`Release ${version}.`]) {
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
    changelog: [{ version, date: "2026-09-25", notes: [...notes] }],
  };
}

describe("checkForUpgrade", () => {
  it("reports up_to_date when there is no release at all", async () => {
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps(undefined));
    expect(result).toEqual({ status: "up_to_date", currentVersion: "0.1.0" });
  });

  it("reports up_to_date when the latest release is not newer", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.1.0")) });
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.1.0", tarball }));
    expect(result.status).toBe("up_to_date");
  });

  it("reports available with the changelog staged from the tarball's workflow.json, for a genuinely newer release", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0", ["Adds the upgrade flow."])) });
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.2.0", tarball, notes: "See CHANGELOG." }));
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("unreachable");
    expect(result.nextVersion).toBe("0.2.0");
    expect(result.changelog).toEqual([{ version: "0.2.0", date: "2026-09-25", notes: ["Adds the upgrade flow."] }]);
    expect(result.releaseNotes).toBe("See CHANGELOG.");
  });

  it("includes every changelog entry newer than currentVersion, not only the latest", async () => {
    const manifest = {
      ...workflowManifest("0.3.0"),
      changelog: [
        { version: "0.1.0", date: "2026-09-01", notes: ["First."] },
        { version: "0.2.0", date: "2026-09-10", notes: ["Second."] },
        { version: "0.3.0", date: "2026-09-20", notes: ["Third."] },
      ],
    };
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(manifest) });
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.3.0", tarball }));
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("unreachable");
    expect(result.changelog.map((e) => e.version)).toEqual(["0.2.0", "0.3.0"]);
  });

  it("refuses (checksum_mismatch) when the downloaded tarball does not match its .sha256, and never reads it as JSON", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("not the tarball"), "job-assistant-0.2.0.tgz"), "utf8");
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.2.0", tarball, checksumBytes: wrongChecksum }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("checksum_mismatch");
    expect(result.nextVersion).toBe("0.2.0");
  });

  it("refuses (unpack_failed) when the verified tarball has no package/workflow.json", async () => {
    const tarball = buildReleaseTarball({ "README.md": "no manifest in here" });
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("unpack_failed");
  });

  it("refuses (invalid_manifest) when workflow.json's own version disagrees with the release tag", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.5.0")) });
    const result = await checkForUpgrade("0.1.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("invalid_manifest");
  });
});

describe("applyUpgrade", () => {
  it("upgrades the workspace: runs migrations, then records the new version, only after re-verifying the release itself", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    expect(workspace.manifest.packageVersion).toBe("0.1.0");
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("upgraded");
    if (result.status !== "upgraded") throw new Error("unreachable");
    expect(result.fromVersion).toBe("0.1.0");
    expect(result.toVersion).toBe("0.2.0");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.2.0");
  });

  it("runs the shipped 0.1.0 -> 0.2.0 fixture migration for real: a pre-migration career-profile.json gets backfilled", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    await workspace.writeJson(["career-profile.json"], {
      claims: [],
      sources: {},
      preferences: [],
      boundaries: [],
      approval: null,
      // presentation and revisions intentionally absent: the pre-0.2.0 shape the shipped fixture migration backfills.
    });
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("upgraded");
    expect(await workspace.readJson("career-profile.json")).toMatchObject({ presentation: [], revisions: [] });
  });

  it("never applies without a matching confirmed version: a stale confirmation (the release moved on) is refused, and nothing changes", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.3.0", fakeUpgradeDeps({ version: "0.2.0", tarball })); // confirmed 0.3.0, but 0.2.0 is what's actually available
    expect(result.status).toBe("stale");
    expect(workspace.manifest.packageVersion).toBe("0.1.0");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("refuses a checksum mismatch and never touches the workspace", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("not the tarball"), "job-assistant-0.2.0.tgz"), "utf8");
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball, checksumBytes: wrongChecksum }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("checksum_mismatch");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("reports up_to_date, applying nothing, when there is no update to confirm", async () => {
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps(undefined));
    expect(result.status).toBe("up_to_date");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });
});

describe("nothing changes without confirmation (F12's core guarantee)", () => {
  it("checkForUpgrade alone never writes to the workspace, however many times it is called", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const deps = fakeUpgradeDeps({ version: "0.2.0", tarball });
    await checkForUpgrade("0.1.0", deps);
    await checkForUpgrade("0.1.0", deps);
    const workspace = await newWorkspace();
    expect(workspace.manifest.packageVersion).toBe("0.1.0"); // checkForUpgrade never even saw this workspace: it takes only a version string
  });

  it("networkForbiddenDeps proves checkForUpgrade for an up-to-date instance still has to ask (it is not a purely local decision) -- and a genuinely unreachable network surfaces as a plain error, not a silent up_to_date", async () => {
    const result = await checkForUpgrade("0.1.0", networkForbiddenDeps);
    expect(result.status).toBe("error");
  });
});
