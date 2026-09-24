import { describe, expect, it } from "vitest";
import { verifyExtractedClaims } from "../agent/lib/extract-claims-logic.ts";
import { ManualClock } from "../lib/clock.ts";
import { ProfileStore } from "../store/profile.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * P03.2 (deliverable 5): `verifyExtractedClaims` is the verify-*only* logic
 * both `agent/tools/extract_claims.ts` and `eval-agent/agent/tools/extract_claims.ts`
 * now share (a thin `"use step"` wrapper in each calls straight into this).
 * Directive-free, so it is tested directly here with a real `ProfileStore`
 * over a temp workspace (read-only: only `sourceText` is ever called) — no
 * eve runtime, no `RUNNER_WORKSPACE`.
 *
 * Before this packet this function was `verifyAndPersistExtractedClaims` and
 * wrote to the store itself; every check below that used to read `store
 * .read()` to see what the tool *saved* now reads the function's own
 * *returned* `claims`/`rejected`, and separately proves the function writes
 * nothing (`store.read().claims` stays empty throughout this file). The
 * moved persistence checks — the store refusing a write, and idempotent
 * persistence across two turns — are now `onboarding-routes.test.ts`
 * tests of the route's own save after an ok turn (see that file's "D14, via
 * the route" and "idempotent... across two turns" cases); the report maps
 * each one.
 */

async function newStore(): Promise<ProfileStore> {
  const clock = new ManualClock();
  const store = new ProfileStore(await newWorkspace(clock), clock);
  await store.accountSource("resume", "provided");
  return store;
}

describe("verifyExtractedClaims", () => {
  it("verifies (never persists) a claim whose evidence quote appears verbatim in the real source text", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs.");

    const result = await verifyExtractedClaims(
      { sourceCategory: "resume", claims: [{ text: "Led the payments team.", kind: "fact", evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" }] },
      store,
    );
    expect(result.claims).toEqual([{ text: "Led the payments team.", kind: "fact", evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" }]);
    expect(result.rejected).toEqual([]);
    expect(result.sourceCategory).toBe("resume");
    expect((await store.read()).claims).toEqual([]); // deliverable 5: the tool never writes; the route does, after an ok turn
  });

  it("drops a claim whose evidence quote is not real, verbatim, in the source — the model's word alone is never trusted", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs.");

    const result = await verifyExtractedClaims(
      { sourceCategory: "resume", claims: [{ text: "Grew revenue 300%.", kind: "metric", evidenceRef: "resume.txt#a", evidenceQuote: "Grew revenue 300%" }] },
      store,
    );
    expect(result.claims).toEqual([]);
    expect(result.rejected).toEqual(["Grew revenue 300%"]);
    expect(result.message).toMatch(/no claim's evidence quote was found in the source text/i);
    expect((await store.read()).claims).toEqual([]);
  });

  it("verifies the good claims and reports the rejected ones separately, in one mixed call", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs. B.S. Computer Science.");

    const result = await verifyExtractedClaims(
      {
        sourceCategory: "resume",
        claims: [
          { text: "Led the payments team.", kind: "fact", evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" },
          { text: "Invented a new algorithm.", kind: "fact", evidenceRef: "resume.txt#b", evidenceQuote: "Invented a new algorithm" },
          { text: "B.S. Computer Science.", kind: "credential", evidenceRef: "resume.txt#c", evidenceQuote: "B.S. Computer Science" },
        ],
      },
      store,
    );
    expect(result.claims.map((c) => c.text).sort()).toEqual(["B.S. Computer Science.", "Led the payments team."]);
    expect(result.rejected).toEqual(["Invented a new algorithm"]);
    expect((await store.read()).claims).toEqual([]);
  });

  it("reports 'no claims supplied' distinctly from 'nothing matched', when the input's own claims list happens to be empty after the caller's own filtering", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team.");
    // extractClaimsInputSchema requires at least one claim, but this function
    // itself does not re-validate that — it only decides what to do once it
    // has iterated whatever it was given, so an empty array exercises its own
    // "No claims supplied" branch directly (distinct from "found some but all rejected").
    const result = await verifyExtractedClaims({ sourceCategory: "resume", claims: [] }, store);
    expect(result.claims).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.message).toBe("No claims supplied.");
  });

  it("verifies the same claim twice as the same result: this layer has no de-duplication of its own (that is store.extractClaims's job, at persist time)", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team.");
    const input = { sourceCategory: "resume" as const, claims: [{ text: "Led the payments team.", kind: "fact" as const, evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" }] };

    const first = await verifyExtractedClaims(input, store);
    const second = await verifyExtractedClaims(input, store);
    expect(first.claims).toEqual(input.claims);
    expect(second.claims).toEqual(input.claims); // unlike the old persisting version, calling this twice is not itself idempotent — persisting is
    expect((await store.read()).claims).toEqual([]);
  });
});
