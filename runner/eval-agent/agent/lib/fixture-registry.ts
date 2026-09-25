import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { respond as jobsRespond } from "./fixtures/jobs.ts";
import { respond as onboardingRespond } from "./fixtures/onboarding.ts";
import { respond as preparationRespond } from "./fixtures/preparation.ts";

/**
 * A later packet's scripted-model branch. Given the current mock-model
 * request, the current turn's `lastUserMessage` (as `prompt`), and whether a
 * tool result is already present (`done`, mirroring `fixture-model.ts`'s own
 * check), return a response for a prompt this handler recognises, or
 * `undefined` to defer to the next handler.
 *
 * Registration is a static import plus one array entry below, not a runtime
 * directory scan: `eve build`/`eve eval` bundles only what is reachable by
 * static import, and a `readdir` of a source-only `fixtures/` folder would
 * find nothing once bundled (the packet's own instructions warn about this).
 * A later packet adds `./fixtures/<name>.ts` (its own handler, mirroring
 * `./fixtures/onboarding.ts`) and one import plus one array entry here —
 * `fixture-model.ts` and `../../evals/tool-surface.eval.ts` are not touched
 * again after P03's one-time setup (see those two files' own comments).
 */
export type FixtureHandler = (request: MockModelRequest, prompt: string, done: boolean) => MockModelResponse | string | undefined;

export const EXTRA_FIXTURE_HANDLERS: readonly FixtureHandler[] = [onboardingRespond, jobsRespond, preparationRespond];
