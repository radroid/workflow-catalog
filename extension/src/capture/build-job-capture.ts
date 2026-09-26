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
 * P07-B revision 4, K4: what the popup's fallback says when the capture
 * doesn't pass the contracts schema -- plain sentences, like every other
 * fallback reason, above the fallback's own next step (paste the posting
 * in the runner's Jobs page). Revision 3 showed "This capture didn't pass
 * validation: " followed by zod's own messages. A page's address is the
 * one realistic cause: url.ts already refuses every scheme but http(s),
 * so what's left is an address longer than the contracts' cap (2,048
 * characters), or one the URL rules reject. The text is normalized and cut
 * to its byte cap above, so it passes.
 */
export const ADDRESS_NOT_ACCEPTED_REASON = "This page's address is too long or unusual to capture.";
export const CAPTURE_NOT_ACCEPTED_REASON = "This page couldn't be captured.";

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
    const addressRefused = parsed.error.issues.some((issue) => issue.path[0] === "url");
    return { ok: false, reason: addressRefused ? ADDRESS_NOT_ACCEPTED_REASON : CAPTURE_NOT_ACCEPTED_REASON };
  }

  return { ok: true, capture: parsed.data };
}
