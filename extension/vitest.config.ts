import { defineConfig } from "vitest/config";

// happy-dom: extractor.test.ts relies on Element.innerText, which jsdom
// does not implement (jsdom does no layout at all); happy-dom ships a
// text-order approximation that is good enough for these fixtures. Every
// other test in this package (crypto, storage, url, text, bridge-client)
// runs fine under the same environment, so this is set package-wide rather
// than per-file.
export default defineConfig({
  test: {
    environment: "happy-dom",
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
