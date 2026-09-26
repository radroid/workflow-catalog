import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// Multi-page MV3 build: three HTML entries (popup/options/sidepanel) plus
// the background service worker as its own non-HTML entry. Chrome loads
// dist/ unpacked, so every path manifest.json names must exist exactly at
// that path in the output — entryFileNames below pins the worker's
// filename; the HTML entries' own output paths (which Vite derives from
// their source path relative to this config's root) are what
// manifest.json's action/options_ui/side_panel paths are written against.
export default defineConfig({
  root: here,
  publicDir: path.resolve(here, "public"),
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    // Review fold-in c: Vite's default modulePreload injects a small
    // feature-detect-and-polyfill snippet (a `fetch(` among other things)
    // into every HTML entry to shim browsers without native
    // `<link rel="modulepreload">` support. minimum_chrome_version 120
    // already has it natively, so the polyfill is dead weight -- and one
    // less `fetch(` for scan-dist-for-eval.mjs and a reviewer to reason
    // about in a build that ships no network calls at all in part A.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: path.resolve(here, "src/popup/index.html"),
        options: path.resolve(here, "src/options/index.html"),
        sidepanel: path.resolve(here, "src/sidepanel/index.html"),
        worker: path.resolve(here, "src/worker/index.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) => (chunkInfo.name === "worker" ? "worker.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
