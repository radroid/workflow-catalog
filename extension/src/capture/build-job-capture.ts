import "../shared/zod-jitless";
import {
  jobCaptureSchema,
  MAX_JOB_CAPTURE_TEXT_BYTES,
  PROTOCOL_VERSION,
  type JobCapture,
} from "@workflow-catalog/contracts";
import { sha256Hex } from "../shared/crypto";
import { normalizeWhitespace, truncateToByteCap } from "../shared/text";
import { EXTRACTOR_VERSION } from "./extractor";

/** Shorter than any realistic posting's title alone — below this, treat
 * the page as unreadable rather than saving a near-empty capture (the
 * same "can't read this page" outcome as an executeScript denial or an
 * unsupported URL scheme; see popup/main.ts). */
export const MIN_CAPTURED_TEXT_LENGTH = 20;

/**
 * The character cap `popup/main.ts` passes to `extractJobPosting` via
 * `executeScript({ args })`, so an oversized page's full `innerText` never
 * gets serialized back across the executeScript boundary at all (review
 * issue 3 fold-in: "Cap the text ... inside the page ... so 30 MB pages
 * don't cross the boundary"). A coarse character count, not the precise
 * byte-accurate cap below — generous enough (4x the byte cap) that
 * `truncateToByteCap` below still has a realistically-sized string to work
 * with afterward, not something already truncated to near-nothing by two
 * layers of capping.
 */
export const MAX_INPAGE_TEXT_CHARS = MAX_JOB_CAPTURE_TEXT_BYTES * 4;

export type BuildJobCaptureResult = { ok: true; capture: JobCapture } | { ok: false; reason: string };

/**
 * Raw extracted text + the tab URL -> a validated `JobCapture` envelope.
 * This is the single place text gets normalized, truncated to the
 * contracts byte cap, and hashed — the popup's preview and its Save both
 * render/export exactly this `capture`, so there is never a discrepancy
 * between what the person previewed and what got saved.
 */
export async function buildJobCapture(params: { url: string; rawText: string }): Promise<BuildJobCaptureResult> {
  const normalized = normalizeWhitespace(params.rawText);
  if (normalized.length < MIN_CAPTURED_TEXT_LENGTH) {
    return { ok: false, reason: "Not enough readable content on this page to capture." };
  }

  const text = truncateToByteCap(normalized, MAX_JOB_CAPTURE_TEXT_BYTES);
  const contentHash = await sha256Hex(text);

  const candidate = {
    protocol: PROTOCOL_VERSION,
    type: "job_capture" as const,
    eventId: crypto.randomUUID(),
    url: params.url,
    text,
    extractorVersion: EXTRACTOR_VERSION,
    contentHash,
    occurredAt: new Date().toISOString(),
  };

  // "It is validated with the contracts schema before anything leaves the
  // popup" — this is that validation; nothing downstream (preview,
  // storage, or the exported file) sees a candidate that failed it.
  const parsed = jobCaptureSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `This capture didn't pass validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }

  return { ok: true, capture: parsed.data };
}
