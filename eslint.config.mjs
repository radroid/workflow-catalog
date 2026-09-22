// Root ESLint flat config. Every workspace package's `lint` script runs
// `eslint . --max-warnings 0` from its own directory; ESLint walks up and
// finds this file since no package defines its own eslint.config.*.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "eslint-config-next";

// eslint-config-next's array targets `**/*.{js,jsx,mjs,ts,tsx,mts,cts}`
// (every file, anywhere) by default. Scope it to apps/catalog only, per
// CLAUDE.md — other packages must never pick up Next/React/JSX rules.
//
// Two further adjustments, both explained in P00's report:
//   - Drop the `next/typescript` entry outright: it only re-registers the
//     `@typescript-eslint` plugin/parser, which `tseslint.configs.recommended`
//     below already provides repo-wide, so keeping it risks a duplicate
//     plugin-registration conflict on catalog's own .ts/.tsx files.
//   - Strip `languageOptions.parser` from the remaining `next` entry. That
//     parser is eslint-config-next's bundled Babel-based parser; letting it
//     win (it's later in the array, so it would override the
//     typescript-eslint parser already set repo-wide) breaks
//     `@typescript-eslint/no-unused-vars` on type-only usages, since Babel's
//     TS handling doesn't feed that rule the same scope information. We keep
//     the entry's plugins/rules (the actual Next lint rules) and drop only
//     the parser override.
const scopedNextConfig = nextPlugin
  .filter((entry) => entry.name !== "next/typescript")
  .map((entry) => {
    const scoped = Array.isArray(entry.files)
      ? { ...entry, files: entry.files.map((pattern) => `apps/catalog/${pattern}`) }
      : Array.isArray(entry.ignores) && !entry.files
        ? { ...entry, ignores: entry.ignores.map((pattern) => `apps/catalog/${pattern}`) }
        : entry;

    if (scoped.languageOptions?.parser) {
      const languageOptions = { ...scoped.languageOptions };
      delete languageOptions.parser;
      return { ...scoped, languageOptions };
    }
    return scoped;
  });

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...scopedNextConfig,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
