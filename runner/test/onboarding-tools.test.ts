import { afterEach, beforeEach, describe, expect, it } from "vitest";
import productionAskFollowUp from "../agent/tools/ask_follow_up.ts";
import productionExtractClaims from "../agent/tools/extract_claims.ts";
import evalAskFollowUp from "../eval-agent/agent/tools/ask_follow_up.ts";
import evalExtractClaims from "../eval-agent/agent/tools/extract_claims.ts";
import { ManualClock } from "../lib/clock.ts";
import { questionNotes } from "../store/profile-reducer.ts";
import { ProfileStore } from "../store/profile.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * V5 (P03 revision 2): the tool modules themselves, in both app roots,
 * driven with a fake `ctx.ask`. Outside eve's build the `"use workflow"` and
 * `"use step"` directives are plain strings, so `execute` runs the real
 * wrappers against a real workspace (`RUNNER_WORKSPACE`, as in production).
 * The eval exercises the eval agent's root; this file is what makes a change
 * to the production wrappers ("always confirm", "no open-claim check") fail.
 *
 * P03.2 (deliverable 5): `extract_claims` is verify-only now (it returns the
 * verified claims and writes nothing); `extractMetric` below persists them
 * itself, the way `onboarding.ts`'s route does after an ok turn, since the
 * `ask_follow_up` tests need a real persisted claim id to exercise against.
 */

interface AskContext {
  ask(request: { prompt: string; options: ReadonlyArray<{ id: string }>; allowFreeform?: boolean }): Promise<{ optionId?: string; text?: string }>;
}

type AskTool = { execute(input: { claimId: string; question: string }, ctx: AskContext): Promise<{ claimId: string; status: string; message: string }> };
type ExtractedClaim = { text: string; kind: string; evidenceRef: string; evidenceQuote: string };
type ExtractTool = { execute(input: unknown, ctx: unknown): Promise<{ claims: ExtractedClaim[]; rejected: string[]; sourceCategory: string }> };

const ROOTS = [
  { root: "agent (production)", ask: productionAskFollowUp as unknown as AskTool, extract: productionExtractClaims as unknown as ExtractTool },
  { root: "eval-agent", ask: evalAskFollowUp as unknown as AskTool, extract: evalExtractClaims as unknown as ExtractTool },
];

const previousWorkspace = process.env.RUNNER_WORKSPACE;
let store: ProfileStore;

beforeEach(async () => {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  process.env.RUNNER_WORKSPACE = workspace.root;
  store = new ProfileStore(workspace, clock);
  await store.accountSource("resume", "provided");
  await store.savePastedText("resume", "Cut the Harbor internal deployment pipeline's release time from a day to under an hour.");
});

afterEach(() => {
  if (previousWorkspace === undefined) delete process.env.RUNNER_WORKSPACE;
  else process.env.RUNNER_WORKSPACE = previousWorkspace;
});

async function extractMetric(tool: ExtractTool): Promise<string> {
  const output = await tool.execute(
    {
      sourceCategory: "resume",
      claims: [
        { text: "Cut the Harbor release time from a day to under an hour.", kind: "metric", evidenceRef: "pasted.txt#1", evidenceQuote: "from a day to under an hour" },
        { text: "Rewrote the whole pipeline alone.", kind: "fact", evidenceRef: "pasted.txt#2", evidenceQuote: "Rewrote the whole pipeline alone" },
      ],
    },
    {},
  );
  expect(output).toMatchObject({
    sourceCategory: "resume",
    claims: [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }],
    rejected: ["Rewrote the whole pipeline alone"],
  });
  // The route's own next step, after an ok turn (deliverable 5): persist what verified.
  const saved = await store.extractClaims("resume", output.claims as never);
  expect(saved.ok).toBe(true);
  return (await store.read()).claims[0]!.id;
}

function answering(answer: { optionId?: string; text?: string }, asked: string[] = []): AskContext {
  return {
    ask: async (request) => {
      asked.push(request.prompt);
      expect(request.options.map((option) => option.id)).toEqual(["confirmed", "excluded"]);
      return answer;
    },
  };
}

for (const { root, ask, extract } of ROOTS) {
  describe(`${root}: extract_claims`, () => {
    it("verifies only claims whose quote is really in the source, writing nothing itself (deliverable 5)", async () => {
      // Q12 (revision 1): the test's own name promises "writing nothing itself" — inlined from
      // extractMetric (rather than calling it) so the profile can be checked *between* the tool call and
      // the route's own simulated persist step, proving the claim below, not just its end state.
      const output = await extract.execute(
        {
          sourceCategory: "resume",
          claims: [
            { text: "Cut the Harbor release time from a day to under an hour.", kind: "metric", evidenceRef: "pasted.txt#1", evidenceQuote: "from a day to under an hour" },
            { text: "Rewrote the whole pipeline alone.", kind: "fact", evidenceRef: "pasted.txt#2", evidenceQuote: "Rewrote the whole pipeline alone" },
          ],
        },
        {},
      );
      expect(output).toMatchObject({
        sourceCategory: "resume",
        claims: [{ text: "Cut the Harbor release time from a day to under an hour.", kind: "metric" }],
        rejected: ["Rewrote the whole pipeline alone"],
      });
      expect((await store.read()).claims).toEqual([]); // the tool alone wrote nothing
      const saved = await store.extractClaims("resume", output.claims as never); // the route's own next step
      expect(saved.ok).toBe(true);
      const claims = (await store.read()).claims;
      expect(claims.map((claim) => claim.status)).toEqual(["candidate"]);
      expect(claims[0]!.id).toBeDefined();
    });

    it("verifies nothing (an empty claims array) when every quote is fabricated, and persists nothing", async () => {
      const output = await extract.execute(
        { sourceCategory: "resume", claims: [{ text: "Founded Quill.", kind: "fact", evidenceRef: "pasted.txt#x", evidenceQuote: "Founded Quill" }] },
        {},
      );
      expect(output).toMatchObject({ claims: [], rejected: ["Founded Quill"] });
      expect((await store.read()).claims).toEqual([]);
    });
  });

  describe(`${root}: ask_follow_up`, () => {
    it("asks the question, then confirms only on the Confirm option", async () => {
      const claimId = await extractMetric(extract);
      const asked: string[] = [];
      const output = await ask.execute({ claimId, question: "Measured against what?" }, answering({ optionId: "confirmed", text: "The Harbor deploy dashboard." }, asked));
      expect(asked).toEqual(["Measured against what?"]);
      expect(output.status).toBe("confirmed");
      const claim = (await store.read()).claims[0]!;
      expect(claim.status).toBe("confirmed");
      expect(claim.evidence).toMatchObject({ kind: "statement", quote: "The Harbor deploy dashboard." });
    });

    it("excludes on the Exclude option", async () => {
      const claimId = await extractMetric(extract);
      const output = await ask.execute({ claimId, question: "Measured against what?" }, answering({ optionId: "excluded" }));
      expect(output.status).toBe("excluded");
      expect((await store.read()).claims[0]!.status).toBe("excluded");
    });

    it("leaves the claim open on a free-text reply and keeps it as a note (D10)", async () => {
      const claimId = await extractMetric(extract);
      const output = await ask.execute({ claimId, question: "Measured against what?" }, answering({ text: "No, I can't back that number up." }));
      expect(output.status).toBe("open");
      expect(output.message).toContain("The claim stays open.");
      const profile = await store.read();
      expect(profile.claims[0]!.status).toBe("disputed");
      expect(profile.claims[0]!.question).toBe("Measured against what?");
      expect(questionNotes(profile)[claimId]?.map((note) => note.text)).toEqual(["No, I can't back that number up."]);
    });

    it("refuses to ask about a claim that already has a decision, and asks nobody", async () => {
      const claimId = await extractMetric(extract);
      await store.decideClaim(claimId, "excluded");
      const asked: string[] = [];
      await expect(ask.execute({ claimId, question: "Measured against what?" }, answering({ optionId: "confirmed" }, asked))).rejects.toThrow("already has a decision (excluded)");
      expect(asked).toEqual([]);
      expect((await store.read()).claims[0]!.status).toBe("excluded");
    });
  });
}
