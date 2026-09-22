import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/catalog/lib/learn.ts -> repo root is three levels up (lib -> catalog
// -> apps -> root), same depth as app/globals.css's "../../../docs/spec/..."
// import. docs/learn lives outside apps/catalog; see next.config.ts's
// outputFileTracingIncludes for why the production build can still read it.
const here = path.dirname(fileURLToPath(import.meta.url));
export const LEARN_ROOT = path.join(here, "..", "..", "..", "docs", "learn");

/** Categories that get their own /learn index section (titled by <title>). */
const INDEXED_CATEGORIES = ["lessons", "reference"] as const;
type Category = (typeof INDEXED_CATEGORIES)[number];

/** Everything servable under /learn/<category>/<file>, including the non-indexed assets/ dir. */
const ASSET_CATEGORIES = [...INDEXED_CATEGORIES, "assets"] as const;
type AssetCategory = (typeof ASSET_CATEGORIES)[number];

function isAssetCategory(value: string | undefined): value is AssetCategory {
  return value !== undefined && (ASSET_CATEGORIES as readonly string[]).includes(value);
}

export interface LearnDoc {
  /** e.g. "lessons/0001-reviewing-an-overnight-agents-work.html" — also the URL path under /learn/. */
  key: string;
  title: string;
  category: Category;
}

export interface LearnIndex {
  lessons: LearnDoc[];
  reference: LearnDoc[];
}

function extractTitle(html: string, fallback: string): string {
  const match = /<title>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() || fallback;
}

function listCategory(category: Category): LearnDoc[] {
  const dir = path.join(LEARN_ROOT, category);
  let filenames: string[];
  try {
    filenames = readdirSync(dir).filter((name) => name.endsWith(".html"));
  } catch {
    return [];
  }
  filenames.sort();

  return filenames.map((filename) => {
    const html = readFileSync(path.join(dir, filename), "utf8");
    return { key: `${category}/${filename}`, title: extractTitle(html, filename), category };
  });
}

/** Built fresh from the directory on every call — a later packet's new lesson file needs no code change to appear. */
export function buildLearnIndex(): LearnIndex {
  const [lessons, reference] = INDEXED_CATEGORIES.map(listCategory);
  return { lessons: lessons ?? [], reference: reference ?? [] };
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // Plain text, not text/markdown: guarantees every browser renders it
  // inline instead of offering it as a download, and no renderer is needed.
  ".md": "text/plain; charset=utf-8",
};

function contentTypeFor(filename: string): string | null {
  const ext = path.extname(filename);
  return ASSET_CONTENT_TYPES[ext] ?? null;
}

export interface ResolvedLearnAsset {
  absolutePath: string;
  contentType: string;
}

/**
 * Resolves a `/learn/<...slug>` request to a file, or null (→ the caller
 * returns 404). Path traversal is structurally impossible, not just
 * pattern-rejected: the only files this can ever return are ones that
 * `readdirSync` itself found in `lessons/`, `reference/`, or `assets/` — a
 * `slug` is only ever compared against that real directory listing, never
 * concatenated into a filesystem path from user input. The explicit `..`
 * check below is belt-and-suspenders on top of that, not the only guard.
 */
export function resolveLearnAsset(slugParts: readonly string[]): ResolvedLearnAsset | null {
  if (slugParts.length === 0) return null;

  // A single-segment slug is a top-level doc (MISSION.md, NOTES.md,
  // RESOURCES.md) — e.g. lesson 0001's relative link `../MISSION.md`
  // resolves in the browser to `/learn/MISSION.md`. Same allowlist
  // discipline as the category branch below: only ever a real, plain file
  // that `readdirSync(LEARN_ROOT)` itself found.
  if (slugParts.length === 1) return resolveTopLevelDoc(slugParts[0]);

  const [category, ...rest] = slugParts;
  if (!isAssetCategory(category)) return null;

  const filename = rest.join("/");
  if (filename.length === 0 || filename.includes("..") || filename.includes("\0")) return null;

  const contentType = contentTypeFor(filename);
  if (!contentType) return null;

  const dir = path.join(LEARN_ROOT, category);
  let realFiles: string[];
  try {
    realFiles = readdirSync(dir);
  } catch {
    return null;
  }
  if (!realFiles.includes(filename)) return null;

  return { absolutePath: path.join(dir, filename), contentType };
}

function resolveTopLevelDoc(filename: string | undefined): ResolvedLearnAsset | null {
  if (!filename || filename.includes("..") || filename.includes("\0")) return null;

  const contentType = contentTypeFor(filename);
  if (!contentType) return null;

  let realFiles: string[];
  try {
    realFiles = readdirSync(LEARN_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  if (!realFiles.includes(filename)) return null;

  return { absolutePath: path.join(LEARN_ROOT, filename), contentType };
}
