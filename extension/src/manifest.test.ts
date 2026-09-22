import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the source manifest.json directly (not a built dist/ copy) so this
// test passes before `build` ever runs, as part of the fast `vitest run`
// pass. `scripts/copy-static-assets.mjs` + `vite build` ship this file
// into dist/ unmodified (Vite's publicDir/root-file passthrough copies
// it verbatim); there is no templating step that could diverge from it.
const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

const REQUIRED_PERMISSIONS = ["activeTab", "scripting", "tabGroups", "storage", "sidePanel", "alarms"];
const REQUIRED_HOST_PERMISSIONS = ["http://127.0.0.1:4310/*"];
const FORBIDDEN_KEYS = ["content_scripts", "content_security_policy", "tabs", "debugger", "icons"];

describe("manifest.json (P07 packet Decisions: exact permission/host sets)", () => {
  it("is manifest_version 3 with the pinned minimum_chrome_version", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("120");
  });

  it("permissions are exactly the six named, no more, no fewer, order-independent", () => {
    expect(manifest.permissions).toBeInstanceOf(Array);
    const permissions = [...(manifest.permissions as string[])].sort();
    expect(permissions).toEqual([...REQUIRED_PERMISSIONS].sort());
  });

  it("host_permissions is exactly the loopback bridge origin, no more, no fewer", () => {
    expect(manifest.host_permissions).toEqual(REQUIRED_HOST_PERMISSIONS);
  });

  it("host_permissions contains no <all_urls> or wildcard host", () => {
    for (const pattern of manifest.host_permissions as string[]) {
      expect(pattern).not.toContain("<all_urls>");
      expect(pattern).not.toMatch(/^\*:\/\//);
      expect(pattern).not.toContain("://*/");
    }
  });

  it("declares no forbidden top-level keys (no content_scripts, no CSP override, no tabs/debugger permission, no icons requiring extra art review)", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(manifest).not.toHaveProperty(key);
    }
    expect((manifest.permissions as string[])).not.toContain("tabs");
    expect((manifest.permissions as string[])).not.toContain("debugger");
  });

  it("has no eval-permitting or remote-code CSP override (absent means Chrome's MV3 default CSP applies)", () => {
    expect(manifest.content_security_policy).toBeUndefined();
  });

  it("background service worker is a module, so it can import the zod-jitless bootstrap first", () => {
    expect(manifest.background).toEqual({ service_worker: "worker.js", type: "module" });
  });

  it("action opens the popup (capture flow: action click -> popup)", () => {
    expect((manifest.action as Record<string, unknown>).default_popup).toBe("src/popup/index.html");
  });

  it("options page and side panel paths are declared", () => {
    expect((manifest.options_ui as Record<string, unknown>).page).toBe("src/options/index.html");
    expect((manifest.side_panel as Record<string, unknown>).default_path).toBe("src/sidepanel/index.html");
  });
});

describe("manifest.json paths resolve inside the built extension (when dist/ exists)", () => {
  const distDir = path.resolve(path.dirname(manifestPath), "dist");
  // A gate here would make the fast `vitest run` pass depend on `vite
  // build` having already run (it hasn't, in the verify chain's order —
  // see package.json); skip instead of failing when dist/ is absent, the
  // same accommodation scan-dist-for-eval.mjs's own build-time check makes.
  const runIfBuilt = existsSync(distDir) ? it : it.skip;

  runIfBuilt("every manifest-referenced page/worker path exists in dist/", () => {
    const referenced = [
      (manifest.background as Record<string, unknown>).service_worker as string,
      (manifest.action as Record<string, unknown>).default_popup as string,
      (manifest.options_ui as Record<string, unknown>).page as string,
      (manifest.side_panel as Record<string, unknown>).default_path as string,
    ];
    for (const relativePath of referenced) {
      expect(existsSync(path.join(distDir, relativePath)), `dist/${relativePath} should exist`).toBe(true);
    }
  });

  // Review fold-in e: copy-static-assets.mjs is a plain byte copy (root
  // manifest.json -> public/manifest.json, which Vite's publicDir
  // passthrough then copies verbatim into dist/), but nothing before this
  // enforced that -- a hand-edit of public/manifest.json alone (skipping
  // the copy step) would silently ship a manifest that diverges from the
  // one reviewed at the repo root. Parsed deep-equal rather than a raw
  // string/byte compare so the intent ("same declared shape") survives
  // incidental whitespace/line-ending differences.
  runIfBuilt("dist/manifest.json is exactly the source manifest.json (copy-static-assets.mjs did not diverge)", () => {
    const builtManifest = JSON.parse(readFileSync(path.join(distDir, "manifest.json"), "utf8")) as unknown;
    expect(builtManifest).toEqual(manifest);
  });
});
