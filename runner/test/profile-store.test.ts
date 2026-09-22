import { SOURCE_CATEGORIES } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { decodeClaimEditSummary, decodeStatementEditSummary } from "../store/profile-reducer.ts";
import { ProfileStore } from "../store/profile.ts";
import { newWorkspace } from "./helpers.ts";

async function newStore(): Promise<ProfileStore> {
  const clock = new ManualClock();
  return new ProfileStore(await newWorkspace(clock), clock);
}

/**
 * `ProfileStore.applyMarkdownEdit` — the store layer that wraps the pure
 * `profile-markdown.ts` helpers with persistence. `test/profile-markdown.test.ts`
 * already covers the pure render/parse/apply round trip in the general
 * case; this file covers the behaviour that only exists at the store layer:
 * a confirmed claim's text edit on an *approved* profile must propose a
 * revision (F5: "after approval, edits become revisions with an explicit
 * accept"; matches `runner/ui/profile.html`'s own copy), not silently
 * overwrite what was approved. This reproduces a real bug found by
 * exercising the Profile page in a browser: the store's first
 * implementation called the pure `applyMarkdownEdits` directly, which has
 * no notion of approval and always overwrote claim text outright.
 *
 * P03 revision 1 (R2) extended the same rule to boundary/preference/
 * presentation statements: the walkthrough never distinguishes "a claim
 * changed" from "a boundary changed" when it comes to what approval means,
 * so a statement edit on an approved profile proposes a revision too,
 * through `editStatementText`, instead of applying directly as it used to.
 */

async function accountAllSources(store: ProfileStore): Promise<void> {
  for (const category of SOURCE_CATEGORIES) {
    await store.accountSource(category, category === "resume" ? "provided" : "not_applicable");
  }
}

describe("ProfileStore.applyMarkdownEdit", () => {
  it("edits a confirmed claim's text directly when the profile is not yet approved", async () => {
    const store = await newStore();
    await accountAllSources(store);
    await store.extractClaims("resume", [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#experience", evidenceQuote: "Worked on the payments team." }]);
    const before = await store.read();
    const claim = before.claims[0]!;
    await store.decideClaim(claim.id, "confirmed");

    const markdown = (await store.renderMarkdown()).replace(claim.text, "Worked on the core payments team.");
    const after = await store.applyMarkdownEdit(markdown);

    expect(after.claims.find((c) => c.id === claim.id)?.text).toBe("Worked on the core payments team.");
    expect(after.revisions).toHaveLength(0);
  });

  it("proposes a revision — never overwrites outright — for a confirmed claim's text edit once the profile is approved", async () => {
    const store = await newStore();
    await accountAllSources(store);
    await store.extractClaims("resume", [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#experience", evidenceQuote: "Worked on the payments team." }]);
    const seeded = await store.read();
    const claim = seeded.claims[0]!;
    await store.decideClaim(claim.id, "confirmed");
    const approved = await store.approve();
    expect(approved.ok).toBe(true);
    expect(approved.profile.approval?.version).toBe(1);

    const markdown = (await store.renderMarkdown()).replace(claim.text, "Worked on the core payments team.");
    const after = await store.applyMarkdownEdit(markdown);

    // The approved text is untouched...
    expect(after.claims.find((c) => c.id === claim.id)?.text).toBe("Worked on the payments team.");
    expect(after.approval?.version).toBe(1);
    // ...and a proposed revision records the edit instead.
    expect(after.revisions).toHaveLength(1);
    const revision = after.revisions[0]!;
    expect(revision.status).toBe("proposed");
    const decoded = decodeClaimEditSummary(revision.summary);
    expect(decoded).toEqual({ claimId: claim.id, text: "Worked on the core payments team." });

    // Accepting the revision is what actually changes the approved text, bumping the version.
    const accepted = await store.acceptRevision(revision.id);
    expect(accepted.ok).toBe(true);
    expect(accepted.profile.claims.find((c) => c.id === claim.id)?.text).toBe("Worked on the core payments team.");
    expect(accepted.profile.approval?.version).toBe(2);
  });

  it("still applies a non-confirmed (candidate) claim's text edit directly, even on an approved profile — there is no revision concept for it", async () => {
    const store = await newStore();
    await accountAllSources(store);
    await store.extractClaims("resume", [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#experience", evidenceQuote: "Worked on the payments team." }]);
    const seeded = await store.read();
    await store.decideClaim(seeded.claims[0]!.id, "confirmed");
    const approved = await store.approve();
    expect(approved.ok).toBe(true);

    // A source re-extracted after approval can add a fresh candidate claim without withdrawing approval.
    await store.extractClaims("resume", [{ text: "Owned the on-call rotation.", kind: "fact", evidenceRef: "resume.md#experience", evidenceQuote: "Owned the on-call rotation." }]);
    const withCandidate = await store.read();
    const candidate = withCandidate.claims.find((c) => c.status === "candidate");
    expect(candidate).toBeDefined();

    const markdown = (await store.renderMarkdown()).replace(candidate!.text, "Owned the entire on-call rotation.");
    const after = await store.applyMarkdownEdit(markdown);

    expect(after.claims.find((c) => c.id === candidate!.id)?.text).toBe("Owned the entire on-call rotation.");
    expect(after.revisions).toHaveLength(0);
  });

  it("edits a boundary statement's text directly when the profile is not yet approved", async () => {
    const store = await newStore();
    await accountAllSources(store);

    const boundary = (await store.read()).boundaries[0]!;
    const markdown = (await store.renderMarkdown()).replace(boundary.text, "Do not invent metrics, credentials, responsibilities, or scope.");
    const after = await store.applyMarkdownEdit(markdown);

    expect(after.boundaries.find((b) => b.id === boundary.id)?.text).toBe("Do not invent metrics, credentials, responsibilities, or scope.");
    expect(after.revisions).toHaveLength(0);
  });

  it("proposes a revision — never overwrites outright — for a boundary statement's text edit once the profile is approved (R2: statements are not exempt from the revision concept)", async () => {
    const store = await newStore();
    await accountAllSources(store);
    await store.extractClaims("resume", [{ text: "Worked on the payments team.", kind: "fact", evidenceRef: "resume.md#experience", evidenceQuote: "Worked on the payments team." }]);
    const seeded = await store.read();
    await store.decideClaim(seeded.claims[0]!.id, "confirmed");
    const approved = await store.approve();
    expect(approved.ok).toBe(true);
    expect(approved.profile.approval?.version).toBe(1);

    const boundary = (await store.read()).boundaries[0]!;
    const markdown = (await store.renderMarkdown()).replace(boundary.text, "Do not invent metrics, credentials, responsibilities, or scope.");
    const after = await store.applyMarkdownEdit(markdown);

    // The approved text is untouched...
    expect(after.boundaries.find((b) => b.id === boundary.id)?.text).toBe(boundary.text);
    expect(after.approval?.version).toBe(1);
    // ...and a proposed revision records the edit instead.
    expect(after.revisions).toHaveLength(1);
    const revision = after.revisions[0]!;
    expect(revision.status).toBe("proposed");
    const decoded = decodeStatementEditSummary(revision.summary);
    expect(decoded).toEqual({ kind: "boundary", statementId: boundary.id, text: "Do not invent metrics, credentials, responsibilities, or scope." });

    // Accepting the revision is what actually changes the approved text, bumping the version.
    const accepted = await store.acceptRevision(revision.id);
    expect(accepted.ok).toBe(true);
    expect(accepted.profile.boundaries.find((b) => b.id === boundary.id)?.text).toBe("Do not invent metrics, credentials, responsibilities, or scope.");
    expect(accepted.profile.approval?.version).toBe(2);
  });
});
