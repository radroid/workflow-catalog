import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// ajv ships dist/2020.d.ts beside dist/2020.js, so this deep import (the
// documented draft-2020-12 entrypoint — ajv README, "Using in ES module")
// resolves without a package "exports" map.
import Ajv2020 from "ajv/dist/2020.js";
// ajv-formats registers actual validators for "date"/"date-time"/"uuid"/etc.
// Without it, ajv (in `strict` mode, which we want) throws on any `format`
// keyword it doesn't recognize rather than silently no-op'ing it.
import addFormats from "ajv-formats";
import { workflowManifestSchema } from "@workflow-catalog/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const workflow = JSON.parse(readFileSync(path.join(pkgRoot, "workflow.json"), "utf8"));
const workflowJsonSchema = JSON.parse(
  readFileSync(path.join(pkgRoot, "schemas", "workflow.schema.json"), "utf8"),
);

const EXACT_BROWSER_PERMISSIONS = ["activeTab", "scripting", "tabGroups", "storage", "sidePanel", "alarms"];
const EXACT_ACTIONS = ["capture_job", "open_application_group", "report_status"];
const EXACT_REQUIRED_SOURCES = [
  "resume",
  "previousCoverLetters",
  "portfolioSite",
  "repositories",
  "socialProfiles",
  "workSamples",
  "targetRolesAndPreferences",
];

describe("workflow.json", () => {
  it("validates against schemas/workflow.schema.json with a real JSON Schema validator (ajv, draft 2020-12)", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(workflowJsonSchema);
    const valid = validate(workflow);
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("also validates against the zod schema directly (belt and suspenders on the same shape)", () => {
    const result = workflowManifestSchema.safeParse(workflow);
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(true);
  });

  it("has a valid semver version", () => {
    expect(workflow.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/);
  });

  it("browserPermissions equal exactly the six allowlisted permissions", () => {
    expect([...workflow.browserPermissions].sort()).toEqual([...EXACT_BROWSER_PERMISSIONS].sort());
  });

  it("actions equal exactly the three allowlisted actions", () => {
    expect([...workflow.actions].sort()).toEqual([...EXACT_ACTIONS].sort());
  });

  it("requiredSources equal exactly the seven F4 source categories", () => {
    expect([...workflow.requiredSources].sort()).toEqual([...EXACT_REQUIRED_SOURCES].sort());
  });

  it("adapters is exactly [\"eve\"]", () => {
    expect(workflow.adapters).toEqual(["eve"]);
  });

  it("does not declare a tarball checksum field — P09-B decides where that lives", () => {
    expect(workflow).not.toHaveProperty("checksum");
    expect(workflow).not.toHaveProperty("tarballChecksum");
  });

  it("schemas[] names every file actually present under schemas/", () => {
    const actual = readdirSync(path.join(pkgRoot, "schemas")).filter((f: string) => f.endsWith(".schema.json"));
    expect([...workflow.schemas].sort()).toEqual([...actual].sort());
  });
});
