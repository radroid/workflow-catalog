import { httpUrlSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { explainUnsupportedUrl, isCapturableUrl } from "./url";

describe("isCapturableUrl / explainUnsupportedUrl", () => {
  it("accepts https URLs", () => {
    expect(isCapturableUrl("https://jobs.example/postings/1")).toBe(true);
    expect(explainUnsupportedUrl("https://jobs.example/postings/1")).toBeNull();
  });

  it("accepts http URLs", () => {
    expect(isCapturableUrl("http://jobs.example/postings/1")).toBe(true);
  });

  it("every accepted URL also passes the contracts httpUrlSchema", () => {
    const url = "https://jobs.example/postings/1?utm=abc";
    expect(isCapturableUrl(url)).toBe(true);
    expect(httpUrlSchema.safeParse(url).success).toBe(true);
  });

  const refused = [
    "chrome://settings",
    "chrome-extension://abcdefghijklmnop/options.html",
    "file:///Users/me/resume.pdf",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "devtools://devtools/bundled/inspector.html",
    "edge://settings",
    "view-source:https://jobs.example/postings/1",
    "blob:https://jobs.example/9a1f2b3c",
  ];

  it.each(refused)("refuses %s with a non-empty reason", (url) => {
    expect(isCapturableUrl(url)).toBe(false);
    const reason = explainUnsupportedUrl(url);
    expect(reason).not.toBeNull();
    expect(reason!.length).toBeGreaterThan(0);
  });

  it("refuses an unparsable string with a clear message instead of throwing", () => {
    expect(() => explainUnsupportedUrl("not a url")).not.toThrow();
    expect(isCapturableUrl("not a url")).toBe(false);
    expect(explainUnsupportedUrl("not a url")).toMatch(/readable address/);
  });

  it("refuses an unlisted-but-non-http(s) scheme generically", () => {
    expect(isCapturableUrl("ftp://example.com/file")).toBe(false);
    expect(explainUnsupportedUrl("ftp://example.com/file")).toMatch(/ftp:.*can't be captured/);
  });
});
