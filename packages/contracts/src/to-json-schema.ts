import { z } from "zod";
import type { SchemaRegistryEntry } from "./registry";

/**
 * The exact bytes committed to `packages/job-assistant/schemas/*.schema.json`
 * for one registry entry — shared by `scripts/emit-schemas.mjs` (the build
 * step, which loads this module through Vite's `ssrLoadModule` so it can run
 * under plain Node without a `.js`-extension convention in `src/` — see that
 * script's header comment) and `schema-drift.test.ts` (which imports it
 * directly, the normal way, under vitest). One implementation, two callers,
 * so the two can never compute JSON Schema differently.
 */
export function generateSchemaDocument(entry: SchemaRegistryEntry): string {
  const jsonSchema = z.toJSONSchema(entry.schema, { target: "draft-2020-12" });
  return `${JSON.stringify(jsonSchema, null, 2)}\n`;
}
