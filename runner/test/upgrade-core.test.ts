import { describe, expect, it } from "vitest";
import { newWorkspace } from "./helpers.ts";
import { buildReleaseTarball, downloadForbiddenUpgradeDeps, fakeUpgradeDeps, networkForbiddenDeps, recordingUpgradeDeps, sha256Line } from "./upgrade-fixtures.ts";
import { applyUpgrade, checkForUpgrade, currentWorkspaceVersion } from "../upgrade/upgrade.ts";
import { MigrationError } from "../upgrade/migrate.ts";

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

  it("reports available with the release's own notes, for a genuinely newer release -- from the release lookup alone, never downloading anything", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0", ["Adds the upgrade flow."])) });
    const result = await checkForUpgrade("0.1.0", downloadForbiddenUpgradeDeps({ version: "0.2.0", tarball, notes: "- Adds the upgrade flow." }));
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("unreachable");
    expect(result.nextVersion).toBe("0.2.0");
    expect(result.releaseNotes).toBe("- Adds the upgrade flow.");
  });

  it("F11: never downloads the tarball or its checksum -- only the release lookup runs, proved by a deps object that throws on any other request", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    // downloadForbiddenUpgradeDeps throws from performRequest for any URL but the GitHub API itself; checkForUpgrade
    // completing at all (let alone reporting "available") is the proof.
    await expect(checkForUpgrade("0.1.0", downloadForbiddenUpgradeDeps({ version: "0.2.0", tarball }))).resolves.toMatchObject({ status: "available", nextVersion: "0.2.0" });
  });

  it("refuses (missing_asset) when the release names neither the expected tarball nor checksum asset -- from the release lookup's own asset list, no download needed", async () => {
    // Serve a release whose tag is newer but whose assets don't match job-assistant-0.2.0.tgz[.sha256] at all; any
    // request but the release lookup itself throws, so a download would fail the test outright.
    const deps = {
      resolve: async () => [{ address: "203.0.113.10", family: 4 as const }],
      performRequest: async (input: { readonly url: URL }) => {
        if (input.url.hostname === "api.github.com") {
          return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ tag_name: "job-assistant@0.2.0", body: "", assets: [] }), "utf8") };
        }
        throw new Error("must not download when assets are missing");
      },
    };
    const result = await checkForUpgrade("0.1.0", deps);
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("missing_asset");
    expect(result.nextVersion).toBe("0.2.0");
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

  it("F11: downloads the tarball and checksum only once confirmed -- a check makes the release lookup alone, and confirming is the first request that downloads either asset", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const { deps, calls } = recordingUpgradeDeps({ version: "0.2.0", tarball });
    const workspace = await newWorkspace();

    await checkForUpgrade("0.1.0", deps);
    expect(calls).toEqual(["release_lookup"]);

    calls.length = 0;
    const result = await applyUpgrade(workspace, "0.2.0", deps);
    expect(result.status).toBe("upgraded");
    expect(calls).toContain("tarball");
    expect(calls).toContain("checksum");
    // The confirm re-verifies the release lookup itself too (never trusting a stale check), but every download
    // happens only inside this one applyUpgrade call, never before it.
    expect(calls.filter((kind) => kind === "release_lookup")).toHaveLength(1);
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

  it("the checksum is verified before the tarball is ever read or parsed: garbage bytes that would throw if unpacked still refuse checksum_mismatch, not unpack_failed", async () => {
    // Not gzip, and not tar even if it were: gunzipSync throws on this, so if applyUpgrade ever tried to read it
    // before checking the checksum, readFileFromReleaseTarball would throw TarballReadError and the result would
    // come back "unpack_failed" instead -- that is exactly the distinction this test is watching for.
    const garbage = Buffer.from("not a gzip file, and not a tar archive either, on purpose".repeat(20), "utf8");
    const wrongChecksum = Buffer.from(sha256Line(Buffer.from("something else entirely"), "job-assistant-0.2.0.tgz"), "utf8");
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball: garbage, checksumBytes: wrongChecksum }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("checksum_mismatch");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("refuses (unpack_failed) when the verified tarball has no package/workflow.json", async () => {
    const tarball = buildReleaseTarball({ "README.md": "no manifest in here" });
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("unpack_failed");
    // The exact message, not only the reason: readFileFromReleaseTarball legitimately returns undefined for two
    // different causes (gzip failure, or a missing entry) and both currently map to "unpack_failed" through two
    // different code paths, so the reason alone can't tell this specific guard apart from, say, a JSON-parse
    // failure that happens to produce the same reason for a different message.
    expect(result.message).toBe("The release tarball has no package/workflow.json.");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("refuses (invalid_manifest) when workflow.json's own version disagrees with the release tag", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.5.0")) });
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") throw new Error("unreachable");
    expect(result.reason).toBe("invalid_manifest");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("reports up_to_date, applying nothing, when there is no update to confirm", async () => {
    const workspace = await newWorkspace();
    const result = await applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps(undefined));
    expect(result.status).toBe("up_to_date");
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
  });

  it("B1b: a failing migration step leaves workspace.json at the old version -- the new version is written only after every step succeeds", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const workspace = await newWorkspace();
    // The shipped 0001 migration throws when career-profile.json isn't a JSON object -- an array qualifies, and is
    // never written by any production code path, so this is a clean way to force a real step to fail for real.
    await workspace.writeJson(["career-profile.json"], []);

    await expect(applyUpgrade(workspace, "0.2.0", fakeUpgradeDeps({ version: "0.2.0", tarball }))).rejects.toThrow(MigrationError);

    // Proof, read fresh off disk (never the in-memory workspace.manifest, which cannot reflect an external write
    // anyway): the version was not moved, and the file the failing step touched was not touched either.
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
    expect(await workspace.readJson("career-profile.json")).toEqual([]);
  });
});

describe("nothing changes without confirmation (F12's core guarantee)", () => {
  it("checkForUpgrade alone never writes to the workspace, however many times it is called -- against a real workspace, not one created only after the fact", async () => {
    const tarball = buildReleaseTarball({ "workflow.json": JSON.stringify(workflowManifest("0.2.0")) });
    const deps = fakeUpgradeDeps({ version: "0.2.0", tarball });
    const workspace = await newWorkspace();
    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");

    await checkForUpgrade(await currentWorkspaceVersion(workspace), deps);
    await checkForUpgrade(await currentWorkspaceVersion(workspace), deps);
    await checkForUpgrade(await currentWorkspaceVersion(workspace), deps);

    expect(await currentWorkspaceVersion(workspace)).toBe("0.1.0");
    expect(await workspace.readJson("career-profile.json").catch(() => undefined)).toBeUndefined();
  });

  it("networkForbiddenDeps proves checkForUpgrade for an up-to-date instance still has to ask (it is not a purely local decision) -- and a genuinely unreachable network surfaces as a plain error, not a silent up_to_date", async () => {
    const result = await checkForUpgrade("0.1.0", networkForbiddenDeps);
    expect(result.status).toBe("error");
  });
});
