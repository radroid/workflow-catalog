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

  it("depends on @workflow-catalog/contracts via workspace:*", () => {
    expect(pkg.dependencies["@workflow-catalog/contracts"]).toBe("workspace:*");
  });

  it("pins zod at exactly 4.5.4", () => {
    expect(pkg.dependencies.zod).toBe("4.5.4");
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
});
