import { describe, expect, it } from "vitest";
import {
  browserCommandResultSchema,
  jobCaptureSchema,
  MAX_CONTENT_HASH_LENGTH,
  MAX_EXTRACTOR_VERSION_LENGTH,
  MAX_JOB_CAPTURE_TEXT_BYTES,
  MAX_JOB_CAPTURE_URL_LENGTH,
  MAX_OCCURRED_AT_LENGTH,
} from "./bridge-envelopes";
import { eventsRequestSchema } from "./bridge-http";
import { httpUrlSchema, MAX_APPLICATION_GROUP_SIZE, MAX_BRIDGE_BODY_BYTES } from "./primitives";

/**
 * Revision 2, fix A: every `POST /events` JSON body zod accepts must serialize
 * (`JSON.stringify`, UTF-8) to at most MAX_BRIDGE_BODY_BYTES, the bridge's
 * 256 KiB body cap (mvp-spec §5). Revision 1 capped `text` by raw UTF-8
 * bytes, which misses JSON escaping, and left `url`, `extractorVersion`,
 * `contentHash` and `occurredAt` unbounded.
 */

/** What the bridge counts: the UTF-8 bytes of the JSON the extension sends. */
function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Upper bound for a string of `n` UTF-16 code units, quotes included (6 bytes per unit is checked exhaustively below). */
function maxStringBytes(n: number): number {
  return 2 + 6 * n;
}

const UUID_A = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const UUID_B = "0d3a4b0e-58cc-4372-a567-0e02b2c3d479";
const URL_PREFIX = "https://jobs.example/";
/** One UTF-16 code unit and one raw UTF-8 byte, but six bytes of JSON: `\u0001`. */
const CONTROL = "\u0001";

/** Padded with fractional-second digits to exactly `length` characters. */
function occurredAtOfLength(length: number): string {
  const head = "2026-09-22T07:00:00.";
  return head + "0".repeat(length - head.length - 1) + "Z";
}

/** Text whose JSON form is exactly `capBytes`: as many copies of `unit` as fit, then ASCII padding. */
function textAtCap(unit: string, capBytes: number): string {
  const unitBytes = serializedBytes(unit) - 2;
  const contentBytes = capBytes - 2;
  const copies = Math.floor(contentBytes / unitBytes);
  return unit.repeat(copies) + "a".repeat(contentBytes - copies * unitBytes);
}

/** A JobCapture with every string at its cap, filled with 6-byte escapes wherever the field admits them. */
function worstJobCapture(text: string) {
  return {
    protocol: 1,
    type: "job_capture",
    eventId: UUID_A,
    url: URL_PREFIX + CONTROL.repeat(MAX_JOB_CAPTURE_URL_LENGTH - URL_PREFIX.length),
    text,
    extractorVersion: CONTROL.repeat(MAX_EXTRACTOR_VERSION_LENGTH),
    contentHash: "f".repeat(MAX_CONTENT_HASH_LENGTH),
    occurredAt: occurredAtOfLength(MAX_OCCURRED_AT_LENGTH),
  };
}

function worstBrowserCommandResult() {
  return {
    protocol: 1,
    type: "browser_command_result",
    eventId: UUID_A,
    commandId: UUID_B,
    status: "completed",
    items: Array.from({ length: MAX_APPLICATION_GROUP_SIZE }, () => ({ taskId: UUID_B, status: "skipped" })),
    occurredAt: occurredAtOfLength(MAX_OCCURRED_AT_LENGTH),
  };
}

function worstApplicationStatusChanged() {
  return {
    protocol: 1,
    type: "application_status_changed",
    eventId: UUID_A,
    taskId: UUID_B,
    expectedRevision: Number.MAX_SAFE_INTEGER,
    status: "deferred",
    occurredAt: occurredAtOfLength(MAX_OCCURRED_AT_LENGTH),
  };
}

function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("every zod-valid POST /events body fits MAX_BRIDGE_BODY_BYTES", () => {
  it("MAX_BRIDGE_BODY_BYTES is 256 KiB", () => {
    expect(MAX_BRIDGE_BODY_BYTES).toBe(262_144);
  });

  it("no UTF-16 code unit serializes to more than 6 bytes of UTF-8 JSON", () => {
    let worst = 0;
    for (let unit = 0; unit <= 0xffff; unit++) {
      worst = Math.max(worst, serializedBytes(String.fromCharCode(unit)) - 2);
    }
    expect(worst).toBe(6);
  });

  it("the JobCapture bound computed from the exported caps is within the cap", () => {
    const skeleton =
      serializedBytes({ ...worstJobCapture(""), url: "", extractorVersion: "", contentHash: "", occurredAt: "" }) -
      5 * 2;
    const bound =
      skeleton +
      MAX_JOB_CAPTURE_TEXT_BYTES +
      maxStringBytes(MAX_JOB_CAPTURE_URL_LENGTH) +
      maxStringBytes(MAX_EXTRACTOR_VERSION_LENGTH) +
      maxStringBytes(MAX_CONTENT_HASH_LENGTH) +
      maxStringBytes(MAX_OCCURRED_AT_LENGTH);
    expect(skeleton).toBe(148);
    expect(bound).toBe(214_364);
    expect(bound).toBeLessThanOrEqual(MAX_BRIDGE_BODY_BYTES);
  });

  it("the worst-case BrowserCommandResult is valid and fits", () => {
    const body = worstBrowserCommandResult();
    expect(eventsRequestSchema.safeParse(body).success).toBe(true);
    expect(serializedBytes(body)).toBeLessThanOrEqual(2_048);
  });

  it("the worst-case ApplicationStatusChanged is valid and fits", () => {
    const body = worstApplicationStatusChanged();
    expect(eventsRequestSchema.safeParse(body).success).toBe(true);
    expect(serializedBytes(body)).toBeLessThanOrEqual(2_048);
  });

  const ADVERSARIAL_UNITS: Array<[label: string, unit: string]> = [
    ["U+0001 (6 bytes as JSON)", CONTROL],
    ["double quotes (2 bytes as JSON)", '"'],
    ["backslashes (2 bytes as JSON)", "\\"],
    ["newlines (2 bytes as JSON)", "\n"],
    ["4-byte emoji", "\u{1F600}"],
    ["3-byte CJK", "字"],
  ];

  describe.each(ADVERSARIAL_UNITS)("JobCapture.text of %s", (_label, unit) => {
    const atCap = textAtCap(unit, MAX_JOB_CAPTURE_TEXT_BYTES);

    it("is valid at exactly the cap, inside a worst-case envelope that fits", () => {
      expect(serializedBytes(atCap)).toBe(MAX_JOB_CAPTURE_TEXT_BYTES);
      const body = worstJobCapture(atCap);
      expect(eventsRequestSchema.safeParse(body).success).toBe(true);
      expect(serializedBytes(body)).toBeLessThanOrEqual(MAX_BRIDGE_BODY_BYTES);
    });

    it("is invalid one byte over the cap", () => {
      const overByOne = atCap + "a";
      expect(serializedBytes(overByOne)).toBe(MAX_JOB_CAPTURE_TEXT_BYTES + 1);
      const result = jobCaptureSchema.safeParse(worstJobCapture(overByOne));
      expect(result.success).toBe(false);
      expect(new Set(issuePaths(result))).toEqual(new Set(["text"]));
    });

    it("is invalid one character over the cap", () => {
      const result = jobCaptureSchema.safeParse(worstJobCapture(atCap + unit));
      expect(result.success).toBe(false);
      expect(new Set(issuePaths(result))).toEqual(new Set(["text"]));
    });
  });

  // The review's reproductions. Under revision 1's raw-byte cap each of these
  // texts was valid, and a JobCapture carrying one serialized to 400,219 B
  // (newlines, quotes, backslashes) or 1,200,219 B (U+0001).
  it.each([
    ["newlines", "\n"],
    ["double quotes", '"'],
    ["backslashes", "\\"],
    ["U+0001", CONTROL],
  ])("rejects %s filling the old raw-byte cap", (_label, unit) => {
    const text = unit.repeat(MAX_JOB_CAPTURE_TEXT_BYTES);
    expect(new TextEncoder().encode(text).length).toBe(MAX_JOB_CAPTURE_TEXT_BYTES);
    expect(jobCaptureSchema.safeParse(worstJobCapture(text)).success).toBe(false);
  });
});

describe("the other POST /events strings and arrays are capped", () => {
  const base = worstJobCapture("Senior Platform Engineer at Northwind Labs.");

  const STRING_CAPS: Array<[field: string, cap: number, ofLength: (n: number) => string]> = [
    ["url", MAX_JOB_CAPTURE_URL_LENGTH, (n) => URL_PREFIX + "a".repeat(n - URL_PREFIX.length)],
    ["extractorVersion", MAX_EXTRACTOR_VERSION_LENGTH, (n) => "e".repeat(n)],
    ["contentHash", MAX_CONTENT_HASH_LENGTH, (n) => "f".repeat(n)],
    ["occurredAt", MAX_OCCURRED_AT_LENGTH, occurredAtOfLength],
  ];

  it.each(STRING_CAPS)("JobCapture.%s is valid at %i characters and invalid at one more", (field, cap, ofLength) => {
    expect(jobCaptureSchema.safeParse({ ...base, [field]: ofLength(cap) }).success).toBe(true);
    const result = jobCaptureSchema.safeParse({ ...base, [field]: ofLength(cap + 1) });
    expect(result.success).toBe(false);
    expect(new Set(issuePaths(result))).toEqual(new Set([field]));
  });

  // zod's URL check trims whitespace and deletes tab/CR/LF before later checks
  // see the value, so a cap chained after it would measure the cleaned string.
  it.each([
    ["trailing spaces", `${URL_PREFIX}p${" ".repeat(MAX_JOB_CAPTURE_URL_LENGTH)}`],
    ["leading spaces", `${" ".repeat(MAX_JOB_CAPTURE_URL_LENGTH)}${URL_PREFIX}p`],
    ["embedded tabs", `${URL_PREFIX}p${"\t".repeat(MAX_JOB_CAPTURE_URL_LENGTH)}q`],
  ])("JobCapture.url counts the raw input: a short URL padded with %s is over the cap", (_label, padded) => {
    expect(httpUrlSchema.safeParse(padded).success).toBe(true);
    expect(jobCaptureSchema.safeParse({ ...base, url: padded }).success).toBe(false);
  });

  it("BrowserCommandResult.items is valid at MAX_APPLICATION_GROUP_SIZE and invalid at one more", () => {
    const body = worstBrowserCommandResult();
    expect(browserCommandResultSchema.safeParse(body).success).toBe(true);
    const tooMany = { ...body, items: [...body.items, { taskId: UUID_A, status: "opened" }] };
    expect(browserCommandResultSchema.safeParse(tooMany).success).toBe(false);
  });

  const EVENT_BUILDERS: Array<[type: string, build: () => Record<string, unknown>]> = [
    ["job_capture", () => base],
    ["browser_command_result", worstBrowserCommandResult],
    ["application_status_changed", worstApplicationStatusChanged],
  ];

  it.each(EVENT_BUILDERS)("%s.occurredAt one character over MAX_OCCURRED_AT_LENGTH is invalid", (_type, build) => {
    const result = eventsRequestSchema.safeParse({
      ...build(),
      occurredAt: occurredAtOfLength(MAX_OCCURRED_AT_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    expect(new Set(issuePaths(result))).toEqual(new Set(["occurredAt"]));
  });
});
