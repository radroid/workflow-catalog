/**
 * `EXTRACTOR_VERSION`: a plain top-level constant, safe to import normally
 * (e.g. from `build-job-capture.ts`) — it is never referenced *inside*
 * `extractJobPosting` below, for exactly the reason explained on that
 * function.
 */
export const EXTRACTOR_VERSION = "extractor@0.1.0";

export interface ExtractedStructuredHints {
  title?: string;
  company?: string;
  location?: string;
  /** Calendar date only (`YYYY-MM-DD`), matching contracts' `jobStructuredSchema.deadline` (`isoDateSchema`). */
  deadline?: string;
  applyUrl?: string;
}

export type ExtractionResult =
  | { ok: true; text: string; structured: ExtractedStructuredHints }
  | { ok: false; reason: string };

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
 * What it does *not* do: decide `contentHash` or enforce the byte cap —
 * both need the contracts package (`sha256Hex`, `MAX_JOB_CAPTURE_TEXT_BYTES`),
 * which cannot be part of this serialized function either. `build-job-capture.ts`
 * does that, back in the extension context, on the raw `text` this returns.
 */
export function extractJobPosting(): ExtractionResult {
  try {
    type JsonRecord = Record<string, unknown>;

    function isRecord(value: unknown): value is JsonRecord {
      return typeof value === "object" && value !== null;
    }

    function asJobPosting(node: unknown): JsonRecord | null {
      if (!isRecord(node)) return null;
      const type = node["@type"];
      const isJobPosting = type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
      if (isJobPosting) return node;
      const graph = node["@graph"];
      if (Array.isArray(graph)) {
        for (const child of graph) {
          const found = asJobPosting(child);
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
          const found = asJobPosting(candidate);
          if (found) return found;
        }
      }
      return null;
    }

    function stringField(node: JsonRecord, key: string): string | undefined {
      const value = node[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    }

    function companyFromHiringOrganization(node: JsonRecord): string | undefined {
      const org = node["hiringOrganization"];
      if (typeof org === "string" && org.trim().length > 0) return org.trim();
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
      return parts.length > 0 ? parts.join(", ") : undefined;
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
      return content && content.trim().length > 0 ? content.trim() : undefined;
    }

    function structuredFromDomHeuristics(): ExtractedStructuredHints {
      const structured: ExtractedStructuredHints = {};
      const h1 = document.querySelector("h1");
      const h1Text = h1 && h1.textContent ? h1.textContent.trim() : "";
      const title = h1Text || metaContent("og:title") || document.title.trim();
      if (title) structured.title = title;
      const company = metaContent("og:site_name");
      if (company) structured.company = company;
      return structured;
    }

    const jsonLdJobPosting = findJsonLdJobPosting();
    const structured = jsonLdJobPosting ? structuredFromJsonLd(jsonLdJobPosting) : structuredFromDomHeuristics();

    const main = document.querySelector("main");
    const source = (main instanceof HTMLElement ? main : document.body) as HTMLElement | null;
    const text = source ? source.innerText : "";

    return { ok: true, text, structured };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error.";
    return { ok: false, reason: message };
  }
}
