import { describe, expect, it } from "vitest";
import { verifyAndPersistExtractedClaims } from "../agent/lib/extract-claims-logic.ts";
import { ManualClock } from "../lib/clock.ts";
import { ProfileStore } from "../store/profile.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * P03 revision 1, R5: `verifyAndPersistExtractedClaims` is the verify-then-
 * persist logic both `agent/tools/extract_claims.ts` and
 * `eval-agent/agent/tools/extract_claims.ts` now share (a thin `"use step"`
 * wrapper in each calls straight into this). Directive-free, so it is
 * tested directly here with a real `ProfileStore` over a temp workspace —
 * no eve runtime, no `RUNNER_WORKSPACE` — exercising exactly the behaviour
 * that was previously duplicated (and, in eval-agent's copy, mis-described
 * as not a copy).
 */

async function newStore(): Promise<ProfileStore> {
  const clock = new ManualClock();
  const store = new ProfileStore(await newWorkspace(clock), clock);
  await store.accountSource("resume", "provided");
  return store;
}

describe("verifyAndPersistExtractedClaims", () => {
  it("persists a claim whose evidence quote appears verbatim in the real source text", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs.");

    const result = await verifyAndPersistExtractedClaims(
      { sourceCategory: "resume", claims: [{ text: "Led the payments team.", kind: "fact", evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" }] },
      store,
    );
    expect(result.added).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(result.persisted).toBe(true); // D14: the route records the content hash only on this
    expect(result.sourceCategory).toBe("resume");
    const profile = await store.read();
    expect(profile.claims).toHaveLength(1);
    expect(profile.claims[0]!.text).toBe("Led the payments team.");
  });

  it("D14: reports persisted: false when the store refuses the write (the source is no longer marked provided)", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs.");
    await store.accountSource("resume", "unavailable");
    const result = await verifyAndPersistExtractedClaims(
      { sourceCategory: "resume", claims: [{ text: "Led the payments team.", kind: "fact", evidenceRef: "pasted.txt#a", evidenceQuote: "Led the payments team" }] },
      store,
    );
    expect(result.persisted).toBe(false);
    expect(result.added).toBe(0);
    expect((await store.read()).claims).toEqual([]);
  });

  it("drops a claim whose evidence quote is not real, verbatim, in the source — the model's word alone is never trusted", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs.");

    const result = await verifyAndPersistExtractedClaims(
      { sourceCategory: "resume", claims: [{ text: "Grew revenue 300%.", kind: "metric", evidenceRef: "resume.txt#a", evidenceQuote: "Grew revenue 300%" }] },
      store,
    );
    expect(result.added).toBe(0);
    expect(result.rejected).toEqual(["Grew revenue 300%"]);
    expect(result.persisted).toBe(false);
    expect(result.message).toMatch(/not.*found|nothing was added/i);
    const profile = await store.read();
    expect(profile.claims).toEqual([]);
  });

  it("persists the verified claims and reports the rejected ones separately, in one mixed call", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team at Northwind Labs. B.S. Computer Science.");

    const result = await verifyAndPersistExtractedClaims(
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
    expect(result.added).toBe(2);
    expect(result.rejected).toEqual(["Invented a new algorithm"]);
    const profile = await store.read();
    expect(profile.claims.map((c) => c.text).sort()).toEqual(["B.S. Computer Science.", "Led the payments team."]);
  });

  it("reports 'no claims supplied' distinctly from 'nothing matched', when the input's own claims list happens to be empty after the caller's own filtering", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team.");
    // extractClaimsInputSchema requires at least one claim, but this function
    // itself does not re-validate that — it only decides what to do once it
    // has iterated whatever it was given, so an empty array exercises its own
    // "No claims supplied" branch directly (distinct from "found some but all rejected").
    const result = await verifyAndPersistExtractedClaims({ sourceCategory: "resume", claims: [] }, store);
    expect(result.added).toBe(0);
    expect(result.rejected).toEqual([]);
    expect(result.message).toBe("No claims supplied.");
  });

  it("is idempotent per (source, evidence): calling it twice with the same claim adds it only once", async () => {
    const store = await newStore();
    await store.savePastedText("resume", "Led the payments team.");
    const input = { sourceCategory: "resume" as const, claims: [{ text: "Led the payments team.", kind: "fact" as const, evidenceRef: "resume.txt#a", evidenceQuote: "Led the payments team" }] };

    const first = await verifyAndPersistExtractedClaims(input, store);
    expect(first.added).toBe(1);
    const second = await verifyAndPersistExtractedClaims(input, store);
    expect(second.added).toBe(0); // profile-reducer.ts's extractClaims action de-duplicates by (source, evidence.ref, evidence.quote)

    const profile = await store.read();
    expect(profile.claims).toHaveLength(1);
  });
});
