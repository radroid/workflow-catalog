import type { NextConfig } from "next";
import path from "node:path";

// apps/catalog is nested two levels under the monorepo root. globals.css
// reaches up to docs/spec/visuals/theme.css (see globals.css), and the
// workspace has one pnpm-lock.yaml at that same root — point Next at it
// explicitly rather than rely on lockfile auto-detection.
const monorepoRoot = path.join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  // Next 16 auto-writes AGENTS.md/CLAUDE.md into this directory on first
  // dev/build. This repo's CLAUDE.md hierarchy is deliberate (see root
  // CLAUDE.md and docs/spec/); do not let Next generate a second, stray one.
  agentRules: false,
  // Keeps the dev-mode route badge out of acceptance screenshots (see
  // CLAUDE.md's screenshot authorization and P09-catalog-site.md §5).
  devIndicators: false,
  // docs/learn lives outside apps/catalog (two levels above this project
  // root); /learn and /learn/[...slug] read it with fs at request time, so
  // the production build's file trace needs to be told about it explicitly
  // or Vercel would not upload those files. Include values are resolved
  // from this project's root (apps/catalog), not from outputFileTracingRoot
  // above — see the outputFileTracingIncludes docs' own monorepo example.
  outputFileTracingIncludes: {
    "/learn": ["../../docs/learn/**/*"],
    "/learn/**": ["../../docs/learn/**/*"],
  },
};

export default nextConfig;
