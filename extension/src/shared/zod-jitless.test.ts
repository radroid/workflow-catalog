import { expect, test } from "vitest";

// Regression test for the CSP eval-probe risk documented in zod-jitless.ts.
// Lives in its own file: Vitest gives every test *file* a fresh module
// registry, so `zod`'s module-level `cached()` getter for `allowsEval` (see
// zod-jitless.ts's comment) has not been touched by any other test yet —
// exactly the isolation zod's own upstream regression test for this same
// issue relies on ("this test lives in its own file because vitest
// isolates ESM graphs per file").
//
// This does not merely check that `z.config({ jitless: true })` was
// *called* — it proves the ordering contract this package actually
// depends on: importing zod-jitless.ts before @workflow-catalog/contracts,
// the way every real entry point does, means contracts can construct and
// parse its `.strict()` schemas without the global `Function` constructor
// ever being invoked.
test("importing zod-jitless before contracts means schema construction and parsing never call the global Function constructor", async () => {
  const originalFunction = globalThis.Function;
  let probeAttempted = false;
  // @ts-expect-error -- stubbing the global constructor for the assertion below
  globalThis.Function = function StubFunction(..._args: unknown[]): never {
    probeAttempted = true;
    throw new Error("global Function should never be constructed when jitless is set first");
  };

  try {
    // Mirrors every real entry point's first two imports, in order.
    await import("./zod-jitless");
    const { jobCaptureSchema } = await import("@workflow-catalog/contracts");

    // Construction happened during the dynamic import above (top-level
    // `z.object(...).strict()` in bridge-envelopes.ts). Parsing is the
    // other call site `allowsEval.value` gates (schemas.ts's object
    // fast-path) — exercise it too so both are covered.
    const result = jobCaptureSchema.safeParse({
      protocol: 1,
      type: "job_capture",
      eventId: "b6f3a5d2-6c2a-4b8a-8e2e-9a2f6b6b2b10",
      url: "https://jobs.example/postings/quill-backend-engineer",
      text: "Backend Engineer — Quill",
      extractorVersion: "extractor@0.1.0",
      contentHash: "a".repeat(64),
      occurredAt: "2026-09-22T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(probeAttempted).toBe(false);
  } finally {
    globalThis.Function = originalFunction;
  }
});
