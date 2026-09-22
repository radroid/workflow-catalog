import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

describe("package.json", () => {
  it("files[] covers workflow.json, skills/, schemas/, templates/, fixtures/, adapters/", () => {
    expect([...pkg.files].sort()).toEqual(
      ["workflow.json", "skills", "schemas", "templates", "fixtures", "adapters"].sort(),
    );
  });

  it("every files[] entry actually exists in the package", () => {
    for (const entry of pkg.files) {
      expect(() => statSync(path.join(pkgRoot, entry)), `missing files[] entry: ${entry}`).not.toThrow();
    }
  });

  // @workflow-catalog/contracts and zod are devDependencies, not
  // dependencies (issue 8): nothing in files[] — the shipped workflow
  // package (schemas as static .schema.json, skills as Markdown, templates
  // as Handlebars) — imports either at runtime. Only this package's own
  // test/*.ts files (dev-time fixture/schema validation) do.
  it("depends on @workflow-catalog/contracts via workspace:*, as a devDependency", () => {
    expect(pkg.dependencies?.["@workflow-catalog/contracts"]).toBeUndefined();
    expect(pkg.devDependencies["@workflow-catalog/contracts"]).toBe("workspace:*");
  });

  it("pins zod at exactly 4.5.4, as a devDependency", () => {
    expect(pkg.dependencies?.zod).toBeUndefined();
    expect(pkg.devDependencies.zod).toBe("4.5.4");
  });
});

describe("adapters/eve/README.md", () => {
  it("exists and is non-empty", () => {
    const content = readFileSync(path.join(pkgRoot, "adapters/eve/README.md"), "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("cites docs/spec/research/eve-runtime.md, not memory, for eve facts", () => {
    const content = readFileSync(path.join(pkgRoot, "adapters/eve/README.md"), "utf8");
    expect(content).toContain("eve-runtime.md");
  });

  // P01 revision decision (d).
  it("documents open_application_group as requiring approval: always()", () => {
    const content = readFileSync(path.join(pkgRoot, "adapters/eve/README.md"), "utf8");
    expect(content).toContain("approval: always()");
  });

  it("documents open_application_group's tool input as task IDs only, never a URL", () => {
    const content = readFileSync(path.join(pkgRoot, "adapters/eve/README.md"), "utf8");
    expect(content).toContain("taskIds");
    expect(content).toContain("task IDs only, never a URL");
  });

  it("documents capture_job and report_status as not model-callable", () => {
    const content = readFileSync(path.join(pkgRoot, "adapters/eve/README.md"), "utf8");
    expect(content).toContain("not model-callable");
  });
});
