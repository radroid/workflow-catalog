import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Same deep-import/addFormats pattern as workflow.test.ts — see its
// comments for why.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import {
  browserCommandResultSchema,
  jobCaptureSchema,
  jobSnapshotSchema,
  MAX_APPLICATION_GROUP_SIZE,
  MAX_CONTENT_HASH_LENGTH,
  MAX_EXTRACTOR_VERSION_LENGTH,
  MAX_JOB_CAPTURE_TEXT_BYTES,
  MAX_JOB_CAPTURE_URL_LENGTH,
  MAX_JOB_SNAPSHOT_TEXT_BYTES,
  MAX_OCCURRED_AT_LENGTH,
  sessionManifestSchema,
  workflowManifestSchema,
} from "@workflow-catalog/contracts";

/*
 * The ajv-vs-zod parity checks for the emitted JSON Schemas: http(s)-only
 * URLs (revision 1, issue 2), the POST /events size caps (revision 2, fix A)
 * and duplicate array entries in workflow.schema.json (revision 2,
 * follow-up D).
 */

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

/**
 * Revision 2, fix A. zod caps `text` by its UTF-8 size as JSON, which no JSON
 * Schema keyword can count. The emitted text fields carry a looser
 * `maxLength` instead (the byte cap minus the 2 quote bytes, in code points)
 * plus a description; the other `POST /events` caps lower to
 * `maxLength`/`maxItems` exactly. So the emitted schemas must never reject a
 * body zod accepts, and must agree with zod wherever JSON Schema can express
 * the cap.
 */
describe("emitted JSON Schema carries the POST /events size caps and is never stricter than zod", () => {
  const validateCapture = ajvValidatorFor("job-capture");
  const validateEvents = ajvValidatorFor("events-request");
  const validateResult = ajvValidatorFor("browser-command-result");

  function occurredAtOfLength(length: number): string {
    const head = "2026-09-22T07:00:00.";
    return head + "0".repeat(length - head.length - 1) + "Z";
  }

  function capture(fields: Record<string, unknown>) {
    return {
      protocol: 1,
      type: "job_capture",
      eventId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      url: VALID_URL,
      text: "Senior Platform Engineer at Northwind Labs.",
      extractorVersion: "extractor@1.0.0",
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      occurredAt: new Date().toISOString(),
      ...fields,
    };
  }

  /** Text whose JSON form is exactly the cap: as many copies of `unit` as fit, then ASCII padding. */
  function textAtCap(unit: string): string {
    const unitBytes = new TextEncoder().encode(JSON.stringify(unit)).length - 2;
    const contentBytes = MAX_JOB_CAPTURE_TEXT_BYTES - 2;
    const copies = Math.floor(contentBytes / unitBytes);
    return unit.repeat(copies) + "a".repeat(contentBytes - copies * unitBytes);
  }

  it.each([
    ["job-capture", MAX_JOB_CAPTURE_TEXT_BYTES],
    ["job-snapshot", MAX_JOB_SNAPSHOT_TEXT_BYTES],
  ])("%s.schema.json: text has maxLength = cap - 2 and a description of where the byte bound is enforced", (name, cap) => {
    const text = JSON.parse(readFileSync(path.join(schemasDir, `${name}.schema.json`), "utf8")).properties.text;
    expect(text.maxLength).toBe(cap - 2);
    expect(text.description).toContain("zod");
    expect(text.description).toContain("256 KB");
  });

  it.each([
    ["U+0001", "\u0001"],
    ["double quotes", '"'],
    ["backslashes", "\\"],
    ["newlines", "\n"],
    ["4-byte emoji", "\u{1F600}"],
    ["3-byte CJK", "字"],
  ])("text of %s filling exactly the byte cap: zod accepts it, and so does ajv", (_label, unit) => {
    const body = capture({ text: textAtCap(unit) });
    expect(jobCaptureSchema.safeParse(body).success).toBe(true);
    expect(validateCapture(body), JSON.stringify(validateCapture.errors)).toBe(true);
    expect(validateEvents(body), JSON.stringify(validateEvents.errors)).toBe(true);
  });

  it("ASCII text: ajv and zod both accept exactly the cap and both reject one more character", () => {
    const atCap = capture({ text: "a".repeat(MAX_JOB_CAPTURE_TEXT_BYTES - 2) });
    const over = capture({ text: "a".repeat(MAX_JOB_CAPTURE_TEXT_BYTES - 1) });
    expect(jobCaptureSchema.safeParse(atCap).success).toBe(true);
    expect(validateCapture(atCap)).toBe(true);
    expect(jobCaptureSchema.safeParse(over).success).toBe(false);
    expect(validateCapture(over)).toBe(false);
  });

  const STRING_CAPS: Array<[field: string, cap: number, ofLength: (n: number) => string]> = [
    ["url", MAX_JOB_CAPTURE_URL_LENGTH, (n) => VALID_URL + "a".repeat(n - VALID_URL.length)],
    ["extractorVersion", MAX_EXTRACTOR_VERSION_LENGTH, (n) => "e".repeat(n)],
    ["contentHash", MAX_CONTENT_HASH_LENGTH, (n) => "f".repeat(n)],
    ["occurredAt", MAX_OCCURRED_AT_LENGTH, occurredAtOfLength],
  ];

  it.each(STRING_CAPS)("%s: ajv and zod both accept %i characters and both reject one more", (field, cap, ofLength) => {
    const atCap = capture({ [field]: ofLength(cap) });
    const over = capture({ [field]: ofLength(cap + 1) });
    expect(jobCaptureSchema.safeParse(atCap).success).toBe(true);
    expect(validateCapture(atCap), JSON.stringify(validateCapture.errors)).toBe(true);
    expect(jobCaptureSchema.safeParse(over).success).toBe(false);
    expect(validateCapture(over)).toBe(false);
  });

  it("browser_command_result.items: ajv and zod both reject one more than MAX_APPLICATION_GROUP_SIZE", () => {
    const body = (count: number) => ({
      protocol: 1,
      type: "browser_command_result",
      eventId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      commandId: "0d3a4b0e-58cc-4372-a567-0e02b2c3d479",
      status: "completed",
      items: Array.from({ length: count }, () => ({ taskId: "1b1b1b1b-58cc-4372-a567-0e02b2c3d479", status: "opened" })),
      occurredAt: new Date().toISOString(),
    });
    expect(browserCommandResultSchema.safeParse(body(MAX_APPLICATION_GROUP_SIZE)).success).toBe(true);
    expect(validateResult(body(MAX_APPLICATION_GROUP_SIZE))).toBe(true);
    expect(browserCommandResultSchema.safeParse(body(MAX_APPLICATION_GROUP_SIZE + 1)).success).toBe(false);
    expect(validateResult(body(MAX_APPLICATION_GROUP_SIZE + 1))).toBe(false);
  });
});

/**
 * Revision 2, follow-up D. workflow-manifest.ts rejects duplicate entries in
 * six arrays with a zod `.refine()`, which JSON Schema never sees, so ajv used
 * to accept duplicates zod rejected. The arrays now carry
 * `.meta({ uniqueItems: true })`, which lands in workflow.schema.json.
 */
describe("emitted workflow.schema.json rejects the duplicate entries zod rejects", () => {
  const validate = ajvValidatorFor("workflow");
  const workflow = JSON.parse(readFileSync(path.resolve(here, "../workflow.json"), "utf8")) as Record<
    string,
    unknown
  >;

  it("ajv and zod both accept workflow.json as shipped", () => {
    expect(validate(workflow), JSON.stringify(validate.errors)).toBe(true);
    expect(workflowManifestSchema.safeParse(workflow).success).toBe(true);
  });

  it.each(["requiredSources", "connections", "browserPermissions", "actions", "schemas", "adapters"])(
    "%s: ajv and zod both reject a repeated entry",
    (key) => {
      const entries = workflow[key] as unknown[];
      const withDuplicate = { ...workflow, [key]: [...entries, entries[0]] };
      expect(validate(withDuplicate), `ajv accepted a duplicate in ${key}`).toBe(false);
      expect(validate.errors?.map((error) => error.keyword)).toContain("uniqueItems");
      expect(workflowManifestSchema.safeParse(withDuplicate).success).toBe(false);
    },
  );
});
