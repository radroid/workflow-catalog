import { describe, expect, it } from "vitest";
import { compareSemver, isNewerSemver, parseSemver } from "../upgrade/semver.ts";

describe("parseSemver", () => {
  it("parses a plain x.y.z", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it("parses a prerelease identifier", () => {
    expect(parseSemver("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });
  });

  it("ignores a build metadata suffix", () => {
    expect(parseSemver("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it("returns undefined for something that is not a semver", () => {
    expect(parseSemver("v1")).toBeUndefined();
    expect(parseSemver("1.2")).toBeUndefined();
    expect(parseSemver("")).toBeUndefined();
  });
});

describe("compareSemver / isNewerSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  it("a prerelease sorts below its own release version", () => {
    expect(compareSemver("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.2.0-rc.1")).toBeGreaterThan(0);
  });

  it("compares prerelease identifiers left to right, numeric before alphanumeric", () => {
    expect(compareSemver("0.2.0-alpha.1", "0.2.0-alpha.2")).toBeLessThan(0);
    expect(compareSemver("0.2.0-alpha", "0.2.0-alpha.1")).toBeLessThan(0); // fewer identifiers, all shared ones equal
    expect(compareSemver("0.2.0-1", "0.2.0-alpha")).toBeLessThan(0); // numeric identifier always lower than alphanumeric
  });

  it("isNewerSemver matches compareSemver's direction", () => {
    expect(isNewerSemver("0.2.0", "0.1.0")).toBe(true);
    expect(isNewerSemver("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerSemver("0.1.0", "0.2.0")).toBe(false);
  });

  it("throws for a non-semver string, naming it", () => {
    expect(() => compareSemver("not-a-version", "0.1.0")).toThrow(/not-a-version/);
  });
});
