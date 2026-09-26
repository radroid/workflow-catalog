/**
 * `EXTRACTOR_VERSION`: a plain top-level constant, safe to import normally
 * (e.g. from `build-job-capture.ts`) — it is never referenced *inside*
 * `extractJobPosting` below, for exactly the reason explained on that
 * function.
 */
export const EXTRACTOR_VERSION = "extractor@0.1.0";

/**
 * P07 part C, gate 5 ("encounter iframe content: show preview/fallback,
 * never silently save the wrong job"): `extractJobPosting` answers
 * `{ ok: false, reason: POSTING_IN_FRAME }` when the page has no JobPosting
 * of its own and most of it is an embedded frame, as an applicant-tracking
 * system's embed is. The extractor runs in the top frame only (it has no
 * access to other frames, and asks for none), so it would otherwise save
 * the page around the frame -- a careers banner -- as if it were the job.
 * The popup shows its fallback for this reason instead. The literal is
 * repeated inside `extractJobPosting`, which must be self-contained;
 * extractor.test.ts checks the two agree.
 */
export const POSTING_IN_FRAME = "posting_in_frame";

/** A frame covering at least this share of the viewport is the page's main content. */
export const MAIN_FRAME_SHARE = 0.4;

export interface ExtractedStructuredHints {
  title?: string;
  company?: string;
  location?: string;
  /** Calendar date only (`YYYY-MM-DD`), matching contracts' `jobStructuredSchema.deadline` (`isoDateSchema`). */
  deadline?: string;
  applyUrl?: string;
}

export type ExtractionResult =
  | { ok: true; text: string; structured: ExtractedStructuredHints; url: string }
  | { ok: false; reason: string };

/**
 * Runtime shape guard for whatever crosses back over the
 * `chrome.scripting.executeScript` boundary as `injectionResults[0].result`
 * (review issue 3 fold-in: "Validate the returned object's shape before
 * use" — a caller trusting a bare `as ExtractionResult` cast is trusting
 * Chrome's serialization *and* the page's influence over it more than it
 * needs to; this checks the actual discriminant and field types before
 * `popup/main.ts` treats the value as real).
 */
export function isExtractionResult(value: unknown): value is ExtractionResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    return typeof record.reason === "string";
  }
  if (record.ok !== true) return false;
  if (typeof record.text !== "string") return false;
  if (typeof record.url !== "string") return false;
  if (typeof record.structured !== "object" || record.structured === null) return false;
  const structured = record.structured as Record<string, unknown>;
  for (const key of ["title", "company", "location", "deadline", "applyUrl"]) {
    if (key in structured && structured[key] !== undefined && typeof structured[key] !== "string") return false;
  }
  return true;
}

/**
 * Passed directly as `chrome.scripting.executeScript({ func: extractJobPosting })`'s
 * `func` (see popup/main.ts). Chrome serializes *only this function's own
 * source* (`Function.prototype.toString`) and re-runs it in the target
 * page's isolated world — it does not carry along imports, module-scope
 * closures, or sibling functions from this file. So this function must be
 * fully self-contained: every helper it uses is declared *inside* its own
 * body, and it references nothing from module scope (not even
 * `EXTRACTOR_VERSION` above — that gets attached by the caller, which runs
 * in the extension's own context, not the page's).
 *
 * `maxTextChars`: passed via `executeScript({ args: [...] })` from
 * `popup/main.ts` (review issue 3 fold-in: "Cap the text ... inside the
 * page ... so 30 MB pages don't cross the boundary"). The cap applied here
 * is a coarse, cheap character slice — not the byte-accurate cap
 * `build-job-capture.ts` applies downstream — its only job is making sure
 * an absurdly large page's `innerText` never gets serialized across
 * `executeScript` at all; precise truncation to the contracts byte cap
 * still happens once, in one place, back in the extension context.
 *
 * What it does *not* do: decide `contentHash` or enforce the byte cap —
 * both need the contracts package (`sha256Hex`, `MAX_JOB_CAPTURE_TEXT_BYTES`),
 * which cannot be part of this serialized function either. `build-job-capture.ts`
 * does that, back in the extension context, on the raw `text` this returns.
 */
export function extractJobPosting(maxTextChars?: number): ExtractionResult {
  try {
    type JsonRecord = Record<string, unknown>;

    // review issue 3 fold-in: structured hints (title/company/location)
    // are cheap to cap independently of the main text cap -- a malicious
    // JSON-LD `title` of unbounded length shouldn't cross the boundary
    // either, and 500 chars is already generous for a real job title.
    const MAX_HINT_CHARS = 500;
    const MAX_GRAPH_DEPTH = 6;

    function capped(value: string): string {
      return value.length > MAX_HINT_CHARS ? value.slice(0, MAX_HINT_CHARS) : value;
    }

    function isRecord(value: unknown): value is JsonRecord {
      return typeof value === "object" && value !== null;
    }

    function asJobPosting(node: unknown, depth: number): JsonRecord | null {
      // review issue 3 fold-in: a deep (or cyclic-looking, since @graph
      // arrays can nest @graph-in-@graph) JSON-LD graph falls back to DOM
      // heuristics instead of recursing without bound.
      if (depth > MAX_GRAPH_DEPTH) return null;
      if (!isRecord(node)) return null;
      const type = node["@type"];
      const isJobPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (isJobPosting) return node;
      const graph = node["@graph"];
      if (Array.isArray(graph)) {
        for (const child of graph) {
          const found = asJobPosting(child, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    function findJsonLdJobPosting(): JsonRecord | null {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(script.textContent ?? "");
        } catch {
          continue;
        }
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const candidate of candidates) {
          const found = asJobPosting(candidate, 0);
          if (found) return found;
        }
      }
      return null;
    }

    function stringField(node: JsonRecord, key: string): string | undefined {
      const value = node[key];
      return typeof value === "string" && value.trim().length > 0 ? capped(value.trim()) : undefined;
    }

    function companyFromHiringOrganization(node: JsonRecord): string | undefined {
      const org = node["hiringOrganization"];
      if (typeof org === "string" && org.trim().length > 0) return capped(org.trim());
      if (isRecord(org)) return stringField(org, "name");
      return undefined;
    }

    function locationFromJobLocation(node: JsonRecord): string | undefined {
      const raw = node["jobLocation"];
      const place = Array.isArray(raw) ? raw[0] : raw;
      if (typeof place === "string") return place.trim() || undefined;
      if (!isRecord(place)) return undefined;
      const address = place["address"];
      if (typeof address === "string") return address.trim() || undefined;
      if (!isRecord(address)) return undefined;
      const parts = [
        stringField(address, "addressLocality"),
        stringField(address, "addressRegion"),
        stringField(address, "addressCountry"),
      ].filter((part): part is string => part !== undefined);
      return parts.length > 0 ? capped(parts.join(", ")) : undefined;
    }

    function deadlineFromValidThrough(node: JsonRecord): string | undefined {
      const value = node["validThrough"];
      if (typeof value !== "string") return undefined;
      const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
      return match ? match[0] : undefined;
    }

    function applyUrlFromUrl(node: JsonRecord): string | undefined {
      const value = node["url"];
      if (typeof value !== "string" || value.trim().length === 0) return undefined;
      try {
        const resolved = new URL(value, document.baseURI);
        return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : undefined;
      } catch {
        return undefined;
      }
    }

    function structuredFromJsonLd(node: JsonRecord): ExtractedStructuredHints {
      const structured: ExtractedStructuredHints = {};
      const title = stringField(node, "title");
      if (title) structured.title = title;
      const company = companyFromHiringOrganization(node);
      if (company) structured.company = company;
      const location = locationFromJobLocation(node);
      if (location) structured.location = location;
      const deadline = deadlineFromValidThrough(node);
      if (deadline) structured.deadline = deadline;
      const applyUrl = applyUrlFromUrl(node);
      if (applyUrl) structured.applyUrl = applyUrl;
      return structured;
    }

    function metaContent(property: string): string | undefined {
      const tag = document.querySelector(`meta[property="${property}"]`);
      const content = tag ? tag.getAttribute("content") : null;
      return content && content.trim().length > 0 ? capped(content.trim()) : undefined;
    }

    function structuredFromDomHeuristics(): ExtractedStructuredHints {
      const structured: ExtractedStructuredHints = {};
      const h1 = document.querySelector("h1");
      const h1Text = h1 && h1.textContent ? h1.textContent.trim() : "";
      const title = h1Text || metaContent("og:title") || document.title.trim();
      if (title) structured.title = capped(title);
      const company = metaContent("og:site_name");
      if (company) structured.company = company;
      return structured;
    }

    // P07 part C, gate 5: most of the page is an embedded frame and the page itself names no JobPosting,
    // so what this frame can read is the page around the posting, not the posting. (0.4: MAIN_FRAME_SHARE.)
    function postingLooksFramed(): boolean {
      const viewport = Math.max(1, window.innerWidth * window.innerHeight);
      for (const frame of Array.from(document.querySelectorAll("iframe, frame"))) {
        const rect = frame.getBoundingClientRect();
        const style = getComputedStyle(frame);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (rect.width * rect.height >= 0.4 * viewport) return true;
      }
      return false;
    }

    const jsonLdJobPosting = findJsonLdJobPosting();
    if (!jsonLdJobPosting && postingLooksFramed()) return { ok: false, reason: "posting_in_frame" };
    const structured = jsonLdJobPosting ? structuredFromJsonLd(jsonLdJobPosting) : structuredFromDomHeuristics();

    const main = document.querySelector("main");
    const source = (main instanceof HTMLElement ? main : document.body) as HTMLElement | null;
    const rawText = source ? source.innerText : "";
    const cap = typeof maxTextChars === "number" && maxTextChars > 0 ? maxTextChars : rawText.length;
    const text = rawText.length > cap ? rawText.slice(0, cap) : rawText;

    // review issue 2: read in the exact same step as the text, so a page
    // that navigates (an SPA route change) between when the caller queried
    // the tab and when this function actually ran can never have its new
    // URL paired with the *previous* page's text. The caller compares this
    // against the URL it queried before invoking executeScript and refuses
    // instead of saving if they disagree.
    const url = location.href;

    return { ok: true, text, structured, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error.";
    return { ok: false, reason: message };
  }
}
