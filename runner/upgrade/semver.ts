/**
 * Minimal semver parsing and comparison for the upgrade flow (F12): comparing
 * the workspace's recorded `packageVersion` against a release's tag, and
 * ordering migration steps. No dependency is added (CLAUDE.md/the packet's
 * Owns say so); `@workflow-catalog/contracts`'s `semverSchema` already pins
 * the exact string shape this parses (`packages/contracts/src/primitives.ts`).
 */
export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated identifiers after a leading "-", e.g. ["rc", "1"]. Absent for a release version. */
  readonly prerelease: readonly string[];
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(version: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

function compareIdentifier(a: string, b: string): number {
  const numA = /^\d+$/.test(a) ? Number(a) : undefined;
  const numB = /^\d+$/.test(b) ? Number(b) : undefined;
  if (numA !== undefined && numB !== undefined) return numA - numB;
  if (numA !== undefined) return -1; // a numeric identifier always has lower precedence than an alphanumeric one
  if (numB !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence (semver.org §11): core version first, then prerelease —
 * a version with a prerelease is always lower than the same core version
 * without one; two prereleases compare identifier by identifier.
 * Returns <0, 0 or >0. Throws only when either string does not parse (a
 * caller should validate with `semverSchema` first; this never happens for
 * `workspace.json`'s own `packageVersion`, which the schema already checked).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`Not a semantic version: "${!pa ? a : b}".`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1; // fewer identifiers sorts first when all shared ones are equal
    if (ib === undefined) return 1;
    const cmp = compareIdentifier(ia, ib);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function isNewerSemver(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}
