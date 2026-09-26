import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_REGISTRY } from "./registry";
import { generateSchemaDocument } from "./to-json-schema";

/**
 * `pnpm --filter contracts build` regenerates
 * `packages/job-assistant/schemas/*.schema.json` from `SCHEMA_REGISTRY` (see
 * `scripts/emit-schemas.mjs`). This test runs under plain `pnpm test` — no
 * build required — and independently regenerates the same documents
 * straight from `src` via Vite's TypeScript resolution, then asserts each
 * one byte-for-byte matches the committed file. A committed schema that
 * fell out of sync with its zod source (forgotten `pnpm --filter contracts
 * build` after an edit) fails here instead of shipping silently stale.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, "../../job-assistant/schemas");

describe("committed JSON Schema files match SCHEMA_REGISTRY", () => {
  for (const entry of SCHEMA_REGISTRY) {
    it(`${entry.name}.schema.json is up to date`, () => {
      const outPath = path.join(schemasDir, `${entry.name}.schema.json`);
      let committed: string;
      try {
        committed = readFileSync(outPath, "utf8");
      } catch {
        throw new Error(
          `${outPath} does not exist — run \`pnpm --filter contracts build\` to generate it.`,
        );
      }

      const regenerated = generateSchemaDocument(entry);

      expect(committed, `${entry.name}.schema.json is stale — run \`pnpm --filter contracts build\``).toBe(
        regenerated,
      );
    });
  }

  it("SCHEMA_REGISTRY names are unique and every committed schema file is named in the registry", () => {
    const names = SCHEMA_REGISTRY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);

    const committedFiles = new Set(
      readdirSync(schemasDir).filter((f: string) => f.endsWith(".schema.json")),
    );
    const registryFiles = new Set(names.map((name) => `${name}.schema.json`));
    expect(committedFiles).toEqual(registryFiles);
  });
});
