import { workflowManifestSchema, type WorkflowChangelogEntry } from "@workflow-catalog/contracts";
import type { Workspace } from "../store/workspace.ts";
import { verifyChecksum } from "./checksum.ts";
import { runMigrations, type RanMigrationStep } from "./migrate.ts";
import { downloadReleaseAsset, fetchLatestRelease, type UpgradeFetchDeps } from "./release-source.ts";
import { compareSemver, isNewerSemver } from "./semver.ts";
import { readFileFromReleaseTarball, TarballReadError } from "./tar.ts";

/**
 * `npm run upgrade` and the Settings "Upgrade" section, both calling
 * `checkForUpgrade` then `applyUpgrade` (P10 packet Deliverables): fetch the
 * release, show the changelog, require confirmation, migrate the workspace,
 * record the new version.
 *
 * "The instance" this stays pinned to is the *workspace's* own recorded
 * `packageVersion` (`workspace.json`, mvp-spec §5) — not the code this
 * checkout happens to have (`ctx.packageVersion`,
 * `packages/job-assistant/workflow.json`'s version, which only changes via
 * `git pull`; `runner/README.md`'s Install section already documents that as
 * the code-upgrade path). An instance can have newer code checked out and
 * still show "an update is available" here until the person confirms:
 * that gap — data not yet migrated — is exactly what F12's "an instance on
 * v1.0.0 stays on it until the person accepts" is pinning.
 *
 * `applyUpgrade` never trusts a check result carried over from an earlier
 * request: it re-fetches and re-verifies the release itself, and refuses
 * (`stale`) if the available release changed underneath a confirmation
 * built from an older check — simpler and safer than caching a download
 * across the local UI's GET/POST calls, and free: no real release exists
 * yet to make re-fetching costly.
 */

const RELEASE_ASSET_TARBALL = (version: string) => `job-assistant-${version}.tgz`;
const RELEASE_ASSET_CHECKSUM = (version: string) => `job-assistant-${version}.tgz.sha256`;
const WORKFLOW_JSON_ENTRY = "package/workflow.json";

export type UpgradeRefusalReason = "missing_asset" | "checksum_mismatch" | "unpack_failed" | "invalid_manifest";

export type UpgradeCheckState =
  | { readonly status: "up_to_date"; readonly currentVersion: string }
  | { readonly status: "available"; readonly currentVersion: string; readonly nextVersion: string; readonly changelog: readonly WorkflowChangelogEntry[]; readonly releaseNotes: string }
  | { readonly status: "refused"; readonly currentVersion: string; readonly nextVersion: string; readonly reason: UpgradeRefusalReason; readonly message: string }
  | { readonly status: "error"; readonly currentVersion: string; readonly message: string };

/** Every changelog entry strictly newer than `currentVersion`, oldest first — what the person confirms covers every version between, not only the latest's own notes. */
function changelogSince(entries: readonly WorkflowChangelogEntry[], currentVersion: string): WorkflowChangelogEntry[] {
  return entries.filter((entry) => isNewerSemver(entry.version, currentVersion)).sort((a, b) => compareSemver(a.version, b.version));
}

/**
 * Checks whether a newer release than `currentVersion` exists and, if so,
 * downloads it, verifies its checksum, and reads its `workflow.json` for the
 * authoritative changelog. Never applies anything — that is `applyUpgrade`'s
 * job, and only after explicit confirmation (P10 packet Decisions).
 */
export async function checkForUpgrade(currentVersion: string, deps: UpgradeFetchDeps = {}): Promise<UpgradeCheckState> {
  const latest = await fetchLatestRelease(deps);
  if (!latest.ok) return { status: "error", currentVersion, message: latest.message };
  if (!latest.release || !isNewerSemver(latest.release.version, currentVersion)) return { status: "up_to_date", currentVersion };

  const { release } = latest;
  const nextVersion = release.version;
  const tarballAsset = release.assets.find((asset) => asset.name === RELEASE_ASSET_TARBALL(nextVersion));
  const checksumAsset = release.assets.find((asset) => asset.name === RELEASE_ASSET_CHECKSUM(nextVersion));
  if (!tarballAsset || !checksumAsset) {
    return { status: "refused", currentVersion, nextVersion, reason: "missing_asset", message: `The ${nextVersion} release is missing its tarball or .sha256 asset. Nothing was changed.` };
  }

  const [tarballResult, checksumResult] = await Promise.all([downloadReleaseAsset(tarballAsset.url, deps), downloadReleaseAsset(checksumAsset.url, deps)]);
  if (!tarballResult.ok) return { status: "error", currentVersion, message: tarballResult.message };
  if (!checksumResult.ok) return { status: "error", currentVersion, message: checksumResult.message };

  // "The release tarball is verified against its .sha256 asset before anything is unpacked. A mismatch refuses plainly, and nothing changes." (P10 packet Decisions)
  const verification = verifyChecksum(tarballResult.bytes, checksumResult.bytes.toString("utf8"));
  if (!verification.ok) {
    return {
      status: "refused",
      currentVersion,
      nextVersion,
      reason: "checksum_mismatch",
      message: verification.parseError ?? "The downloaded release does not match its published checksum. Nothing was changed.",
    };
  }

  let workflowJsonBytes: Uint8Array | undefined;
  try {
    workflowJsonBytes = readFileFromReleaseTarball(tarballResult.bytes, WORKFLOW_JSON_ENTRY);
  } catch (error) {
    return { status: "refused", currentVersion, nextVersion, reason: "unpack_failed", message: error instanceof TarballReadError ? error.message : "Could not read the release tarball." };
  }
  if (!workflowJsonBytes) {
    return { status: "refused", currentVersion, nextVersion, reason: "unpack_failed", message: `The release tarball has no ${WORKFLOW_JSON_ENTRY}.` };
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(Buffer.from(workflowJsonBytes).toString("utf8"));
  } catch {
    return { status: "refused", currentVersion, nextVersion, reason: "unpack_failed", message: `${WORKFLOW_JSON_ENTRY} in the release tarball is not valid JSON.` };
  }
  const manifest = workflowManifestSchema.safeParse(parsedManifest);
  if (!manifest.success) {
    return { status: "refused", currentVersion, nextVersion, reason: "invalid_manifest", message: `${WORKFLOW_JSON_ENTRY} in the release tarball does not match the workflow manifest contract.` };
  }
  if (manifest.data.version !== nextVersion) {
    return { status: "refused", currentVersion, nextVersion, reason: "invalid_manifest", message: `The release is tagged ${nextVersion} but its workflow.json says ${manifest.data.version}.` };
  }

  return { status: "available", currentVersion, nextVersion, changelog: changelogSince(manifest.data.changelog, currentVersion), releaseNotes: release.notes };
}

export type UpgradeApplyResult =
  | { readonly status: "upgraded"; readonly fromVersion: string; readonly toVersion: string; readonly ranSteps: readonly RanMigrationStep[] }
  | { readonly status: "refused"; readonly reason: UpgradeRefusalReason; readonly message: string }
  | { readonly status: "stale"; readonly message: string }
  | { readonly status: "up_to_date"; readonly currentVersion: string }
  | { readonly status: "error"; readonly message: string };

/**
 * Applies the upgrade to `expectedNextVersion`: re-runs `checkForUpgrade`
 * (never trusting a caller-supplied changelog or bytes), refuses `stale`
 * if what is actually available has moved on, then runs the workspace
 * migrations and — only once every step has succeeded — records the new
 * version in `workspace.json`. Requires `expectedNextVersion` explicitly:
 * the caller (the route, the CLI's confirmation prompt) is the only place
 * "confirmed" is decided; this function itself never asks.
 */
export async function applyUpgrade(workspace: Workspace, expectedNextVersion: string, deps: UpgradeFetchDeps = {}): Promise<UpgradeApplyResult> {
  const currentVersion = workspace.manifest.packageVersion;
  const check = await checkForUpgrade(currentVersion, deps);
  if (check.status === "up_to_date") return { status: "up_to_date", currentVersion };
  if (check.status === "error") return { status: "error", message: check.message };
  if (check.status === "refused") return { status: "refused", reason: check.reason, message: check.message };
  if (check.nextVersion !== expectedNextVersion) {
    return { status: "stale", message: `The available release is now ${check.nextVersion}, not ${expectedNextVersion}. Check again before confirming.` };
  }

  const migration = await runMigrations({ currentVersion, targetVersion: check.nextVersion, workspace });
  await workspace.writeJson(["workspace.json"], { ...workspace.manifest, packageVersion: check.nextVersion });
  return { status: "upgraded", fromVersion: currentVersion, toVersion: check.nextVersion, ranSteps: migration.ranSteps };
}

/**
 * `workspace.manifest` is fixed at whatever `Workspace.open`/`create` read;
 * a successful `applyUpgrade` writes a new `workspace.json` without
 * reopening it (the runner keeps one `Workspace` instance for the bridge's
 * whole run). Callers that must reflect an upgrade within the same process
 * (the Settings route's own GET, right after a POST confirm) read the file
 * fresh through this instead of `workspace.manifest.packageVersion`.
 */
export async function currentWorkspaceVersion(workspace: Workspace): Promise<string> {
  const raw = (await workspace.readJson("workspace.json").catch(() => undefined)) as { packageVersion?: unknown } | undefined;
  return typeof raw?.packageVersion === "string" ? raw.packageVersion : workspace.manifest.packageVersion;
}
