import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Same deep-import/addFormats pattern as workflow.test.ts — see its
// comments for why.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { jobCaptureSchema, jobSnapshotSchema, sessionManifestSchema } from "@workflow-catalog/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, "../schemas");

function ajvValidatorFor(schemaFileBaseName: string) {
  const jsonSchema = JSON.parse(readFileSync(path.join(schemasDir, `${schemaFileBaseName}.schema.json`), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(jsonSchema);
}

const VALID_URL = "https://jobs.example/posting/1";
// The exact threats httpUrlSchema's doc comment (primitives.ts) names:
// "reject javascript:, local files, privileged browser URLs, and arbitrary
// code."
const DANGEROUS_URLS = ["javascript:alert(1)", "file:///etc/passwd", "chrome-extension://abc/page.html"];

/**
 * Issue 2 regression. `httpUrlSchema`'s http(s)-only restriction was
 * `z.url({ protocol: /^https?$/ })` — a zod-only runtime refinement
 * invisible to `z.toJSONSchema`. The *emitted* `.schema.json` described any
 * absolute URL, `javascript:`/`file:`/`chrome-extension:` included, as
 * valid — so an ajv-based consumer (the bridge server, or anything else
 * validating against the shipped JSON Schema rather than importing zod
 * directly) would silently accept exactly what the zod runtime rejects.
 * The fix pairs the option with a redundant `.regex(/^https?:\/\//)`,
 * which *does* lower to JSON Schema's `"pattern"` keyword.
 *
 * These tests assert ajv (compiled from the committed `.schema.json`) and
 * zod (the live schema) agree on one valid and several dangerous URLs, at
 * every nesting depth `httpUrlSchema` is actually used: a top-level field,
 * a field nested inside an optional object, and a field inside an array
 * item.
 */
describe("emitted JSON Schema enforces the same http(s)-only URL restriction zod does", () => {
  const cases: Array<{
    schemaFileBaseName: string;
    zodSchema: z.ZodType;
    label: string;
    build: (url: string) => unknown;
  }> = [
    {
      schemaFileBaseName: "job-snapshot",
      zodSchema: jobSnapshotSchema,
      label: "JobSnapshot.url (top-level field)",
      build: (url) => ({
        jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        revision: 1,
        url,
        capturedAt: new Date().toISOString(),
        extractorVersion: "extractor@1.0.0",
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        text: "Senior Platform Engineer at Northwind Labs.",
        structured: {},
      }),
    },
    {
      schemaFileBaseName: "job-snapshot",
      zodSchema: jobSnapshotSchema,
      label: "JobSnapshot.structured.applyUrl (field nested in an optional object)",
      build: (url) => ({
        jobId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        revision: 1,
        url: VALID_URL,
        capturedAt: new Date().toISOString(),
        extractorVersion: "extractor@1.0.0",
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        text: "Senior Platform Engineer at Northwind Labs.",
        structured: { applyUrl: url },
      }),
    },
    {
      schemaFileBaseName: "job-capture",
      zodSchema: jobCaptureSchema,
      label: "JobCapture.url (top-level field)",
      build: (url) => ({
        protocol: 1,
        type: "job_capture",
        eventId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        url,
        text: "Senior Platform Engineer at Northwind Labs.",
        extractorVersion: "extractor@1.0.0",
        contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        occurredAt: new Date().toISOString(),
      }),
    },
    {
      schemaFileBaseName: "session-manifest",
      zodSchema: sessionManifestSchema,
      label: "SessionManifest.items[].url (field inside an array item)",
      build: (url) => ({
        protocol: 1,
        sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        title: "Apply today",
        items: [{ taskId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479", jobRevision: 1, url }],
        createdAt: new Date().toISOString(),
      }),
    },
  ];

  for (const { schemaFileBaseName, zodSchema, label, build } of cases) {
    describe(label, () => {
      const validate = ajvValidatorFor(schemaFileBaseName);

      it("ajv (emitted JSON Schema) and zod both accept an https:// URL", () => {
        const payload = build(VALID_URL);
        expect(validate(payload), JSON.stringify(validate.errors, null, 2)).toBe(true);
        expect(zodSchema.safeParse(payload).success).toBe(true);
      });

      for (const dangerous of DANGEROUS_URLS) {
        it(`ajv (emitted JSON Schema) and zod both reject ${dangerous}`, () => {
          const payload = build(dangerous);
          expect(validate(payload), "ajv accepted a non-http(s) URL the emitted schema should reject").toBe(
            false,
          );
          expect(zodSchema.safeParse(payload).success).toBe(false);
        });
      }
    });
  }
});
