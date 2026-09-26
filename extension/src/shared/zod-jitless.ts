/**
 * Must be the FIRST import in every extension entry point (popup, options,
 * sidepanel, worker) — before `@workflow-catalog/contracts` or `zod` is
 * imported by anything else in that entry's module graph.
 *
 * Why: zod 4.5.4's object-schema parser (`$ZodObjectJIT`, used by every
 * `.strict()` schema in `@workflow-catalog/contracts`) probes eval
 * availability the moment a schema is *constructed* — i.e. at module
 * evaluation time for `packages/contracts/src/*.ts`'s top-level
 * `z.object(...)` calls — by calling `new Function("")` inside a
 * try/catch (`node_modules/zod/src/v4/core/util.ts`, `allowsEval`). The
 * call is aliased through a local variable (`const F = Function; new
 * F("")`), so it will not match a literal `new Function` string scan
 * either. Under this extension's manifest (no `content_security_policy`
 * override, so Chrome's MV3 default applies — `script-src 'self'`, no
 * `'unsafe-eval'`), that call is blocked and reports as a
 * `securitypolicyviolation` (Chrome DevTools surfaces it as an Issue) even
 * though the throw itself is swallowed — this is a known upstream issue
 * (zod #4461, #5414) with a documented fix in zod's own regression test,
 * `zod/src/v4/classic/tests/jitless-allows-eval.test.ts`: call
 * `z.config({ jitless: true })` before the first schema parse/construction,
 * which short-circuits `allowsEval` to `false` without ever calling
 * `new Function`.
 *
 * ES module import evaluation is depth-first in source order: a module's
 * own imports fully evaluate, in the order they appear, before any of that
 * module's own top-level statements run. So as long as this module (which
 * has zero imports of its own beyond `zod`, and does nothing but this one
 * call) is the first import an entry point's `main.ts` names, `z.config`
 * below always runs before `@workflow-catalog/contracts` gets a chance to
 * construct a schema — regardless of how deep the import chain to
 * contracts is, and regardless of how Vite/Rollup chunks the output.
 * `zod-jitless.test.ts` is a regression test for exactly this ordering
 * contract, modelled on zod's own test.
 */
import { z } from "zod";

z.config({ jitless: true });
