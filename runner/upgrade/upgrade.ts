import { workflowManifestSchema } from "@workflow-catalog/contracts";
import type { Workspace } from "../store/workspace.ts";
import { verifyChecksum } from "./checksum.ts";
import { runMigrations, type RanMigrationStep } from "./migrate.ts";
import { downloadReleaseAsset, fetchLatestRelease, type ReleaseAsset, type UpgradeFetchDeps } from "./release-source.ts";
import { isNewerSemver } from "./semver.ts";
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
 * **What each network call is for, and when it happens** (gate review round
 * 1, F11 reclassified BLOCKING: "every Settings page load calls the GitHub
 * API and downloads the tarball and .sha256, unasked"):
 *   - `checkForUpgrade` — the "Check for updates" button only — calls
 *     GitHub's `releases/latest` and nothing else. It can tell `up_to_date`
 *     from `available` from the tag alone, and can refuse `missing_asset`
 *     from the release's own asset list, all without downloading a single
 *     byte of the release itself. The changelog shown is the release's own
 *     notes (`release.notes`, GitHub's release body — `release-package.yml`
 *     writes it from `workflow.json`'s changelog entry for that version),
 *     not a value read out of the tarball.
 *   - `applyUpgrade` — only after the person confirms — re-does that same
 *     lookup (never trusting a check carried over from an earlier request:
 *     see below), and only once it has re-confirmed a matching release is
 *     still available does it download the tarball and its `.sha256`,
 *     verify the checksum, and read `workflow.json` out of the verified
 *     tarball to confirm the release is what it claims to be, before
 *     running any migration.
 * So loading Settings, or polling its status, makes no network request at
 * all; a check makes the release lookup only; a confirm is the first and
 * only request that ever downloads the release's bytes.
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
  | { readonly status: "available"; readonly currentVersion: string; readonly nextVersion: string; readonly releaseNotes: string }
  | { readonly status: "refused"; readonly currentVersion: string; readonly nextVersion: string; readonly reason: UpgradeRefusalReason; readonly message: string }
  | { readonly status: "error"; readonly currentVersion: string; readonly message: string };

/** `checkForUpgrade`'s result, plus the release's asset locations when one is available — `applyUpgrade`'s only use of this: it never re-derives asset URLs itself, and never downloads them until confirmation is already established. */
interface ReleaseLookup {
  readonly state: UpgradeCheckState;
  readonly tarballAsset?: ReleaseAsset;
  readonly checksumAsset?: ReleaseAsset;
}

/**
 * The lookup shared by `checkForUpgrade` and `applyUpgrade`: one GitHub API
 * call (`fetchLatestRelease`), nothing else. Whether the release is newer,
 * and whether it names the two assets an upgrade needs, are both answerable
 * from that one response — no download required.
 */
async function lookupRelease(currentVersion: string, deps: UpgradeFetchDeps): Promise<ReleaseLookup> {
  const latest = await fetchLatestRelease(deps);
  if (!latest.ok) return { state: { status: "error", currentVersion, message: latest.message } };
  if (!latest.release || !isNewerSemver(latest.release.version, currentVersion)) return { state: { status: "up_to_date", currentVersion } };

  const { release } = latest;
  const nextVersion = release.version;
  const tarballAsset = release.assets.find((asset) => asset.name === RELEASE_ASSET_TARBALL(nextVersion));
  const checksumAsset = release.assets.find((asset) => asset.name === RELEASE_ASSET_CHECKSUM(nextVersion));
  if (!tarballAsset || !checksumAsset) {
    return { state: { status: "refused", currentVersion, nextVersion, reason: "missing_asset", message: `The ${nextVersion} release is missing its tarball or .sha256 asset. Nothing was changed.` } };
  }

  return { state: { status: "available", currentVersion, nextVersion, releaseNotes: release.notes }, tarballAsset, checksumAsset };
}

/**
 * Checks whether a newer release than `currentVersion` exists, from GitHub's
 * release lookup alone — never downloads the release itself. Never applies
 * anything, and never leaves the "Check for updates" button — that is
 * `applyUpgrade`'s job, and only after explicit confirmation (P10 packet
 * Decisions).
 */
export async function checkForUpgrade(currentVersion: string, deps: UpgradeFetchDeps = {}): Promise<UpgradeCheckState> {
  return (await lookupRelease(currentVersion, deps)).state;
}

export type UpgradeApplyResult =
  | { readonly status: "upgraded"; readonly fromVersion: string; readonly toVersion: string; readonly ranSteps: readonly RanMigrationStep[] }
  | { readonly status: "refused"; readonly reason: UpgradeRefusalReason; readonly message: string }
  | { readonly status: "stale"; readonly message: string }
  | { readonly status: "up_to_date"; readonly currentVersion: string }
  | { readonly status: "error"; readonly message: string };

/**
 * Applies the upgrade to `expectedNextVersion`: re-runs the release lookup
 * (never trusting a caller-supplied changelog or release notes), refuses
 * `stale` if what is actually available has moved on, downloads and
 * verifies the release only now, then runs the workspace migrations and —
 * only once every step has succeeded — records the new version in
 * `workspace.json`. Requires `expectedNextVersion` explicitly: the caller
 * (the route, the CLI's confirmation prompt) is the only place "confirmed"
 * is decided; this function itself never asks.
 */
export async function applyUpgrade(workspace: Workspace, expectedNextVersion: string, deps: UpgradeFetchDeps = {}): Promise<UpgradeApplyResult> {
  const currentVersion = workspace.manifest.packageVersion;
  const lookup = await lookupRelease(currentVersion, deps);
  const { state } = lookup;
  if (state.status === "up_to_date") return { status: "up_to_date", currentVersion };
  if (state.status === "error") return { status: "error", message: state.message };
  if (state.status === "refused") return { status: "refused", reason: state.reason, message: state.message };
  if (state.nextVersion !== expectedNextVersion) {
    return { status: "stale", message: `The available release is now ${state.nextVersion}, not ${expectedNextVersion}. Check again before confirming.` };
  }
  const nextVersion = state.nextVersion;

  // Only now, with confirmation already established against a release that is still actually available, does
  // anything get downloaded (F11: "the tarball and its .sha256 are downloaded only after the person confirms").
  const [tarballResult, checksumResult] = await Promise.all([downloadReleaseAsset(lookup.tarballAsset!.url, deps), downloadReleaseAsset(lookup.checksumAsset!.url, deps)]);
  if (!tarballResult.ok) return { status: "error", message: tarballResult.message };
  if (!checksumResult.ok) return { status: "error", message: checksumResult.message };

  // "The release tarball is verified against its .sha256 asset before anything is unpacked. A mismatch refuses plainly, and nothing changes." (P10 packet Decisions)
  const verification = verifyChecksum(tarballResult.bytes, checksumResult.bytes.toString("utf8"));
  if (!verification.ok) {
    return { status: "refused", reason: "checksum_mismatch", message: verification.parseError ?? "The downloaded release does not match its published checksum. Nothing was changed." };
  }

  let workflowJsonBytes: Uint8Array | undefined;
  try {
    workflowJsonBytes = readFileFromReleaseTarball(tarballResult.bytes, WORKFLOW_JSON_ENTRY);
  } catch (error) {
    return { status: "refused", reason: "unpack_failed", message: error instanceof TarballReadError ? error.message : "Could not read the release tarball." };
  }
  if (!workflowJsonBytes) {
    return { status: "refused", reason: "unpack_failed", message: `The release tarball has no ${WORKFLOW_JSON_ENTRY}.` };
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(Buffer.from(workflowJsonBytes).toString("utf8"));
  } catch {
    return { status: "refused", reason: "unpack_failed", message: `${WORKFLOW_JSON_ENTRY} in the release tarball is not valid JSON.` };
  }
  const manifest = workflowManifestSchema.safeParse(parsedManifest);
  if (!manifest.success) {
    return { status: "refused", reason: "invalid_manifest", message: `${WORKFLOW_JSON_ENTRY} in the release tarball does not match the workflow manifest contract.` };
  }
  if (manifest.data.version !== nextVersion) {
    return { status: "refused", reason: "invalid_manifest", message: `The release is tagged ${nextVersion} but its workflow.json says ${manifest.data.version}.` };
  }

  const migration = await runMigrations({ currentVersion, targetVersion: nextVersion, workspace });
  await workspace.writeJson(["workspace.json"], { ...workspace.manifest, packageVersion: nextVersion });
  return { status: "upgraded", fromVersion: currentVersion, toVersion: nextVersion, ranSteps: migration.ranSteps };
}

/**
 * `workspace.manifest` is fixed at whatever `Workspace.open`/`create` read;
 * a successful `applyUpgrade` writes a new `workspace.json` without
 * reopening it (the runner keeps one `Workspace` instance for the bridge's
 * whole run). Callers that must reflect an upgrade within the same process
 * (the Settings route's own status read, right after a confirm), or that
 * must never touch the network at all (a page load), read the file fresh
 * through this instead of `workspace.manifest.packageVersion` — this makes
 * no network request of its own.
 */
export async function currentWorkspaceVersion(workspace: Workspace): Promise<string> {
  const raw = (await workspace.readJson("workspace.json").catch(() => undefined)) as { packageVersion?: unknown } | undefined;
  return typeof raw?.packageVersion === "string" ? raw.packageVersion : workspace.manifest.packageVersion;
}
