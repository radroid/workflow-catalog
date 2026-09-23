import { describe, expect, it } from "vitest";
import { extractReadableText } from "../lib/readable-text.ts";

/**
 * `readable-text.ts`'s own tests (P04 packet: "give each a small documented
 * interface and its own tests"). No dependency was added for this (out of
 * this packet's `Owns`), so it is a small, dependency-free HTML-to-text pass
 * — good enough for a job posting's prose and lists, never a renderer.
 */

describe("extractReadableText: text/plain", () => {
  it("passes plain text through, trimmed and whitespace-normalized", () => {
    expect(extractReadableText("  Staff Engineer   at Northwind Labs.  \n\n\n\nApply now.  ", "text/plain")).toBe("Staff Engineer at Northwind Labs.\n\nApply now.");
  });
});

describe("extractReadableText: text/html", () => {
  it("strips tags and keeps the readable text", () => {
    const html = "<html><body><h1>Staff Engineer</h1><p>Northwind Labs is hiring.</p></body></html>";
    expect(extractReadableText(html, "text/html")).toBe("Staff Engineer\nNorthwind Labs is hiring.");
  });

  it("removes script and style content entirely, never just their tags", () => {
    const html = '<html><head><style>body{color:red}</style></head><body><script>alert("hi")</script><p>Real content.</p></body></html>';
    const text = extractReadableText(html, "text/html");
    expect(text).toBe("Real content.");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("alert");
  });

  it("removes HTML comments", () => {
    const html = "<p>Before</p><!-- a hidden comment --><p>After</p>";
    const text = extractReadableText(html, "text/html");
    expect(text).not.toContain("hidden comment");
    expect(text).toBe("Before\nAfter");
  });

  it("turns list items and line breaks into separate lines", () => {
    const html = "<p>Requirements:</p><ul><li>Node.js</li><li>TypeScript</li></ul><p>Line one<br>Line two</p>";
    const text = extractReadableText(html, "text/html");
    expect(text.split("\n")).toEqual(["Requirements:", "Node.js", "TypeScript", "Line one", "Line two"]);
  });

  it("decodes common HTML entities", () => {
    const html = "<p>Salary: $100k &amp; equity &mdash; apply &gt; 5 years exp &lt; 10</p>";
    expect(extractReadableText(html, "text/html")).toBe("Salary: $100k & equity — apply > 5 years exp < 10");
  });

  it("decodes numeric entities, decimal and hex", () => {
    expect(extractReadableText("<p>&#65;&#x42;&#67;</p>", "text/html")).toBe("ABC");
  });

  it("never throws on malformed or hostile markup, and never executes anything", () => {
    const hostile = '<div><img src=x onerror="alert(1)"><script>while(true){}</script><p>Still readable</p><unclosed';
    expect(() => extractReadableText(hostile, "text/html")).not.toThrow();
    const text = extractReadableText(hostile, "text/html");
    expect(text).toContain("Still readable");
    expect(text).not.toContain("<script");
  });

  it("returns an empty string for a page with no text content", () => {
    expect(extractReadableText("<html><head><title>t</title></head><body></body></html>", "text/html")).toBe("");
  });

  it("never leaves a blank line between adjacent block elements", () => {
    const html = "<p>A</p><div></div><div></div><div></div><p>B</p>";
    const text = extractReadableText(html, "text/html");
    expect(text).not.toMatch(/\n\n/);
    expect(text).toBe("A\nB");
  });
});
