// Loaded with `node --import ./lib/register-ts.mjs` by every runner script
// (setup, doctor, pair, runner). Node 24 strips TypeScript types natively,
// but its ESM resolver needs a file extension on every relative import.
// @workflow-catalog/contracts is consumed as TypeScript source and imports its
// siblings without an extension (`./primitives`), the form bundlers such as
// Next.js need (P01 review). This hook retries such a specifier with `.ts`
// and `/index.ts`, and changes nothing else: bare package names, `node:`
// builtins and specifiers that already carry an extension resolve as usual.
//
// module.registerHooks is synchronous and in-thread (Node 22.15+/23.5+).

import { registerHooks } from "node:module";

const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== "ERR_MODULE_NOT_FOUND" || !RELATIVE.test(specifier) || HAS_EXTENSION.test(specifier)) {
        throw error;
      }
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next candidate
        }
      }
      throw error;
    }
  },
});
