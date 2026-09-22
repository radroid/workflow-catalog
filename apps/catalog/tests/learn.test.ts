import { describe, expect, it } from "vitest";
import { buildLearnIndex, resolveLearnAsset } from "../lib/learn";

describe("learn docs index", () => {
  it("lists lessons and reference docs by their <title>", () => {
    const index = buildLearnIndex();
    expect(index.lessons.length).toBeGreaterThan(0);
    expect(index.reference.length).toBeGreaterThan(0);

    const first = index.lessons[0];
    expect(first?.key).toMatch(/^lessons\/.*\.html$/);
    expect(first?.title.length).toBeGreaterThan(0);
    // Real content check, not just "is a string": these fixtures ship in
    // the repo (docs/learn/lessons) and their <title> starts with "Lesson".
    expect(first?.title).toMatch(/^Lesson /);
  });
});

describe("learn asset resolution — path traversal", () => {
  it("resolves a real lesson, reference doc, and asset", () => {
    const lesson = resolveLearnAsset(["lessons", "0001-reviewing-an-overnight-agents-work.html"]);
    expect(lesson).not.toBeNull();
    expect(lesson?.contentType).toBe("text/html; charset=utf-8");

    const reference = resolveLearnAsset(["reference", "review-checklist.html"]);
    expect(reference).not.toBeNull();

    const css = resolveLearnAsset(["assets", "course.css"]);
    expect(css).not.toBeNull();
    expect(css?.contentType).toBe("text/css; charset=utf-8");

    const js = resolveLearnAsset(["assets", "quiz.js"]);
    expect(js).not.toBeNull();
    expect(js?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("404s (returns null) for .. path traversal attempts", () => {
    expect(resolveLearnAsset(["lessons", "..", "..", "package.json"])).toBeNull();
    expect(resolveLearnAsset(["lessons", "..", "MISSION.md"])).toBeNull();
    expect(resolveLearnAsset(["assets", "..", "..", "..", "..", "..", "etc", "passwd"])).toBeNull();
    expect(resolveLearnAsset(["lessons", "sub", "..", "..", "..", "package.json"])).toBeNull();
  });

  it("404s (returns null) for unknown filenames in a real category", () => {
    expect(resolveLearnAsset(["lessons", "0099-does-not-exist.html"])).toBeNull();
    expect(resolveLearnAsset(["reference", "not-a-real-reference.html"])).toBeNull();
    expect(resolveLearnAsset(["assets", "not-a-real-asset.css"])).toBeNull();
  });

  it("404s (returns null) for an unknown category", () => {
    expect(resolveLearnAsset(["not-a-category", "whatever.html"])).toBeNull();
  });

  it("404s (returns null) for a category with nothing after it, or an empty slug", () => {
    expect(resolveLearnAsset(["lessons"])).toBeNull();
    expect(resolveLearnAsset([])).toBeNull();
  });

  it("404s (returns null) for a disallowed extension even if the base name matches", () => {
    expect(resolveLearnAsset(["lessons", "0001-reviewing-an-overnight-agents-work.html.bak"])).toBeNull();
  });

  it("404s (returns null) for a nested path under a real category", () => {
    expect(resolveLearnAsset(["lessons", "sub", "0001-reviewing-an-overnight-agents-work.html"])).toBeNull();
  });
});

describe("learn asset resolution — top-level docs", () => {
  it("resolves the real top-level docs a lesson can link to with '../'", () => {
    // Lesson 0001 links to "../MISSION.md", which resolves in the browser
    // to /learn/MISSION.md — a single-segment slug, not category/filename.
    for (const name of ["MISSION.md", "NOTES.md", "RESOURCES.md"]) {
      const doc = resolveLearnAsset([name]);
      expect(doc).not.toBeNull();
      expect(doc?.contentType).toBe("text/plain; charset=utf-8");
    }
  });

  it("404s (returns null) for an unknown top-level filename", () => {
    expect(resolveLearnAsset(["NOPE.md"])).toBeNull();
  });

  it("404s (returns null) for a top-level traversal attempt", () => {
    expect(resolveLearnAsset([".."])).toBeNull();
    expect(resolveLearnAsset(["..%2Fpackage.json"])).toBeNull();
  });
});
