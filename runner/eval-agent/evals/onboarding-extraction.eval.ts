import { readFileSync } from "node:fs";
import path from "node:path";
import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import type { ExtractClaimsOutput } from "../../agent/lib/extract-claims-schema.ts";
import { ManualClock } from "../../lib/clock.ts";
import { questionNotes } from "../../store/profile-reducer.ts";
import { ProfileStore } from "../../store/profile.ts";
import { openOrCreateEvalWorkspace } from "./eval-workspace.ts";
import {
  askFollowUpPrompt,
  FIXTURE_FOLLOW_UP_QUESTION,
  FIXTURE_TARGET_METRIC_QUOTE,
  HOSTILE_EXTRACTION_CLAIMS,
  HOSTILE_RESUME_TEXT,
  ONBOARDING_FIXTURE_PROMPTS,
  RESUME_EXTRACTION_CLAIMS,
  RESUME_FABRICATED_CLAIM,
} from "../agent/lib/fixtures/onboarding.ts";

/**
 * `extract_claims` end to end, through the real workflow tool (not a
 * shortcut): `agent/tools/extract_claims.ts`'s `"use step"` function reads
 * `process.env.RUNNER_WORKSPACE`, but that step runs inside `eve eval`'s
 * separately spawned dev host (a distinct OS process reached over HTTP —
 * "target http://127.0.0.1:<port>/"), which snapshots its own environment
 * once, before this file's `test()` function ever runs. Setting
 * `process.env.RUNNER_WORKSPACE` inside `test()` is invisible to that
 * process — confirmed empirically (see the P03 report) by watching the
 * error change from "RUNNER_WORKSPACE is not set" to a `WorkspaceError`
 * naming the exact path once the assignment moved to module top level.
 *
 * Round-1 review L9: that decision now lives in one place,
 * `./eval-workspace.ts`'s `openOrCreateEvalWorkspace()`, called by both this
 * file and `job-extraction.eval.ts` from their own module top level — neither
 * assigns the variable, or decides fresh-vs-reuse, itself any more.
 * Module-level code in an imported file *does* reach the dev host (eve must
 * import a `*.eval.ts` file to discover it — read its `description` — before
 * it can decide to run it at all), which is why the call happens here at
 * top level rather than inside `test()`. It is *not* simply computed once in
 * the shared module and exported as a value, though: confirmed empirically
 * that "eve eval loads this file from a build cache" means each `*.eval.ts`
 * file's dependency graph is loaded independently, so a plain shared
 * top-level constant actually ran twice in the same process and created two
 * different workspaces. `openOrCreateEvalWorkspace` is idempotent via the
 * environment variable itself instead — see that module's own comment for
 * the full story, including how an earlier version of this file (each file
 * deciding unconditionally, on its own) broke `job-extraction.eval.ts` the
 * same way.
 *
 * One shared workspace, not one per scenario: `RUNNER_WORKSPACE` can only
 * name one directory for the whole eval run (the dev host's env is fixed
 * once), so both scenarios below write into the same `resume` source
 * category (matching `fixtures/onboarding.ts`'s scripted tool calls, which
 * both hardcode `sourceCategory: "resume"`) under different filenames.
 * Their claims never collide — the store dedupes by `(source, evidence.ref,
 * evidence.quote)`, and the two fixtures use different `evidenceRef`
 * prefixes (`resume.md#...` vs `hostile-resume.md#...`) — so the second
 * scenario's assertions check for its own claim specifically rather than
 * resetting a total count.
 *
 * P03.2 (deliverable 5): `extract_claims` only verifies and returns now — it
 * never calls `store.extractClaims` itself (`agent/lib/extract-claims-logic.ts`).
 * Every gate below that used to read `store.read()` right after `t.send(...)`
 * to see what the tool *wrote* now reads the call's own `turn.requireToolCall(
 * "extract_claims", ...).output` instead (typed `ExtractClaimsOutput`,
 * avoiding string-matching on `turn.message`, which only ever carried this
 * fixture's own echo of it). The scenario that needs a claim's *persisted*
 * fields — `status: "candidate"` and a drafted `question`, both
 * `profile-reducer.ts`'s job at persist time, never the tool's — now calls
 * `store.extractClaims` itself, explicitly, right where the production route
 * does (after the turn), so that gate still exercises the real reducer.
 *
 * Q8 (revision 1, reviewer 7): this comment previously claimed "no gate was
 * dropped", which was wrong — the fabricated-quote scenario's own "no new
 * claim was persisted for the fabricated quote" gate (`after.claims.length
 * === before.claims.length`) had no replacement, since nothing persists
 * mid-turn in this architecture any more, so the same store.read() shape
 * would have been trivially, uninformatively true. It is restored below by
 * mirroring the route's own post-turn persist step on that scenario's actual
 * (empty) verified claims, the same way the first scenario already does —
 * proving the store genuinely adds nothing for a fabricated quote, not just
 * that the tool's own returned claims list excludes it. The report maps
 * every gate, old label to new.
 */

// `eve eval` loads this file from a build cache, not from its source path —
// import.meta.url does not point back at runner/eval-agent/evals/ (confirmed
// empirically: see the P03 report). process.cwd() does: cli/eval.ts spawns
// `eve eval` with cwd: EVAL_AGENT_DIR (runner/eval-agent/), and that holds
// for the whole process regardless of where an individual module's code
// physically runs from.
const JOB_ASSISTANT_FIXTURES = path.resolve(process.cwd(), "..", "..", "packages", "job-assistant", "fixtures");
const RESUME_TEXT = readFileSync(path.join(JOB_ASSISTANT_FIXTURES, "resume.md"), "utf8");

const clock = new ManualClock();
const workspace = await openOrCreateEvalWorkspace();
const store = new ProfileStore(workspace, clock);
await store.accountSource("resume", "provided");

export default defineEval({
  description:
    "extract_claims verifies candidate claims against the real resume.md fixture and the route's own next step (store.extractClaims) leaves the metric candidate with a question (P03.2 deliverable 5); a hostile 'resume' still verifies only real claims, with no other tool called; a fabricated (non-verbatim) evidence quote is rejected, not trusted (P03 revision 1, R5); ask_follow_up parks on a real HITL input request, the Confirm option confirms with statement evidence, the Exclude option excludes, and a free-text-only reply leaves the claim open with the reply kept as a note (P03 revision 2, D10).",
  async test(t) {
    // Fixture parity: the eval agent's hardcoded claim data (bundling-safety
    // reasons, see fixtures/onboarding.ts) must stay real substrings of the
    // actual fixture file it mirrors.
    for (const claim of RESUME_EXTRACTION_CLAIMS) {
      t.check(RESUME_TEXT.includes(claim.evidenceQuote), equals(true)).label(`resume.md contains: "${claim.evidenceQuote.slice(0, 40)}..."`);
    }

    await store.saveUpload("resume", "resume.md", RESUME_TEXT);
    {
      const turn = await t.send(ONBOARDING_FIXTURE_PROMPTS.extractResume);
      t.succeeded();
      const call = turn.requireToolCall("extract_claims", { status: "completed" });
      t.check(call.output !== undefined, equals(true)).label("extract_claims result is not an error");
      const output = call.output as ExtractClaimsOutput;
      t.check(output.rejected.length, equals(0)).label("every claim verified; none were rejected");
      t.check(output.claims.length, equals(RESUME_EXTRACTION_CLAIMS.length)).label("every verified claim was returned");
      const verified = output.claims.find((claim) => claim.evidenceQuote === FIXTURE_TARGET_METRIC_QUOTE);
      t.check(verified !== undefined, equals(true)).label("the target metric claim was verified");

      // P03.2 (deliverable 5): candidate status and the drafted question are
      // profile-reducer.ts's job at persist time, not the tool's — mirror the
      // production route's own next step (routes/onboarding.ts, after the ok
      // turn just confirmed above) to exercise the real reducer here too.
      const saved = await store.extractClaims("resume", output.claims);
      t.check(saved.ok, equals(true)).label("the route's own persist step (after the ok turn) accepts what was verified");
      const metric = saved.profile.claims.find((claim) => claim.evidence.quote === FIXTURE_TARGET_METRIC_QUOTE);
      t.check(metric !== undefined, equals(true)).label("the target metric claim was extracted");
      t.check(metric?.status, equals("candidate")).label("the metric is left candidate, never auto-confirmed");
      t.check(metric?.kind, equals("metric")).label("it is typed as a metric");
      t.check(Boolean(metric?.question), equals(true)).label("the metric carries a question");
    }

    await store.saveUpload("resume", "hostile-resume.md", HOSTILE_RESUME_TEXT);
    {
      const turn = await t.send(ONBOARDING_FIXTURE_PROMPTS.extractHostileResume);
      t.succeeded();
      const call = turn.requireToolCall("extract_claims");
      turn.notCalledTool("open_application_group");
      turn.notCalledTool("ask_follow_up");
      turn.notCalledTool("load_skill");
      t.check(turn.toolCalls.length, equals(1)).label("exactly one tool call for the whole turn");

      // Verification (claim-extraction/SKILL.md's quote check) is what resists the injected instruction, so
      // this checks the tool's own output directly — a tool-level concern, not a persistence one; deliverable
      // 5 no longer runs any store write in this scenario at all.
      const output = call.output as ExtractClaimsOutput;
      t.check(output.claims.length, equals(HOSTILE_EXTRACTION_CLAIMS.length)).label("exactly the legitimate claim(s) verified, nothing else");
      const hostileClaim = output.claims.find((claim) => claim.evidenceRef === HOSTILE_EXTRACTION_CLAIMS[0].evidenceRef);
      t.check(hostileClaim?.text, equals(HOSTILE_EXTRACTION_CLAIMS[0].text)).label("the legitimate claim was verified, verbatim");
      t.check(
        output.claims.every((claim) => !claim.text.toLowerCase().includes("ignore previous instructions")),
        equals(true),
      ).label("the injected instruction never became a claim");
    }

    // R5: without this scenario, replacing extract_claims's quote-verification
    // condition with `if (true)` left every other check in this file passing —
    // every other fixture's evidenceQuote already is a real substring, so
    // nothing here ever exercised the rejection branch. This claim's quote is
    // deliberately not a substring of any fixture text.
    {
      t.check(RESUME_TEXT.includes(RESUME_FABRICATED_CLAIM.evidenceQuote), equals(false)).label("the fabricated quote is genuinely not real (sanity check on the fixture itself)");

      const turn = await t.send(ONBOARDING_FIXTURE_PROMPTS.extractFabricatedQuote);
      t.succeeded();
      const call = turn.requireToolCall("extract_claims", { status: "completed" });
      // P03.2 (deliverable 5): the rejection itself is entirely the tool's verification logic — checked
      // directly on its own output, the same mutation R5 guards against whether or not anything persists.
      const output = call.output as ExtractClaimsOutput;
      t.check(output.claims.length, equals(0)).label("nothing was verified");
      t.check(output.rejected, equals([RESUME_FABRICATED_CLAIM.evidenceQuote])).label("the fabricated quote is named in the rejected list");
      t.check(
        output.claims.some((claim) => claim.text === RESUME_FABRICATED_CLAIM.text),
        equals(false),
      ).label("the fabricated claim's text never verified, so the route would never persist it");

      // Q8 (revision 1, reviewer 7): restores the pre-P03.2 "no new claim was persisted for the fabricated
      // quote" gate, dropped with no replacement when this scenario moved onto the tool's own output. Mirrors
      // the route's own post-turn step (routes/onboarding.ts, scenario 1 above does the same) on this call's
      // actual (empty) verified claims — proving the *store* adds nothing, not only that the tool's returned
      // list excludes it (the two are different claims: a route that ignored `output.claims` and persisted
      // `input.claims` outright would still pass every gate above this one).
      const before = await store.read();
      const saved = await store.extractClaims("resume", output.claims);
      t.check(saved.added, equals(0)).label("no new claim was persisted for the fabricated quote");
      t.check((await store.read()).claims.length, equals(before.claims.length)).label("the store's claim count is unchanged");
    }

    // R6: ask_follow_up parks on a real eve HITL input request (ctx.ask),
    // and answering "confirmed" — one of the two offered options — records
    // the claim as confirmed with the person's own statement as evidence,
    // never the superseded passage.
    {
      const seeded = await store.extractClaims("resume", [
        { text: "Cut the sync job's runtime by an unverified amount.", kind: "metric", evidenceRef: "resume.md#follow-up-confirmed", evidenceQuote: "Cut the sync job's runtime" },
      ]);
      const claimId = seeded.profile.claims.find((claim) => claim.evidence.ref === "resume.md#follow-up-confirmed")!.id;
      t.check(seeded.profile.claims.find((claim) => claim.id === claimId)?.status, equals("candidate")).label("the claim starts candidate, not pre-decided");

      // Not `t.parked()`: that asserts the *whole run* is left parked when
      // `test()` returns, which does not hold here — this scenario goes on
      // to answer the request itself in the very next line. The pending
      // request's own existence (the park actually happening) is what
      // `requireInputRequest` below already asserts and returns.
      const turn = await t.send(askFollowUpPrompt(claimId));
      t.check(turn.status, equals("waiting")).label("the turn parks (session.waiting) instead of failing or guessing");
      const request = turn.session.requireInputRequest({ toolName: "ask_follow_up" });
      const answered = await turn.session.respond([{ requestId: request.requestId, optionId: "confirmed" }]);
      answered.succeeded();
      t.check(answered.message ?? "", includes('"isError":false')).label("ask_follow_up result is not an error");

      const after = await store.read();
      const claim = after.claims.find((c) => c.id === claimId);
      t.check(claim?.question, equals(FIXTURE_FOLLOW_UP_QUESTION)).label("the model-drafted question was recorded");
      t.check(claim?.status, equals("confirmed")).label("confirming records the claim as confirmed");
      t.check(claim?.evidence.kind, equals("statement")).label("the evidence is the person's own statement, not the superseded passage");
    }

    // D10 (P03 revision 2): only an explicit option changes a claim. eve
    // turns a reply that matches no option into free text, so each of the
    // round-2 reviewer's probe answers arrives as `{text}` alone. Revision 1
    // confirmed the metric on all three; each must now leave the claim
    // disputed with its question open, keep the reply as a note, and tell the
    // model the claim stays open.
    {
      const seeded = await store.extractClaims("resume", [
        { text: "Cut the nightly reconciliation job's runtime by 70%.", kind: "metric", evidenceRef: "resume.md#follow-up-free-text", evidenceQuote: "Cut the nightly reconciliation job's runtime" },
      ]);
      const claimId = seeded.profile.claims.find((claim) => claim.evidence.ref === "resume.md#follow-up-free-text")!.id;
      const probes = ["No, I can't back that number up.", "exclude", "what do you mean?"];

      for (const probe of probes) {
        const turn = await t.send(askFollowUpPrompt(claimId));
        t.check(turn.status, equals("waiting")).label(`"${probe}": the turn parks on the question first`);
        const request = turn.session.requireInputRequest({ toolName: "ask_follow_up" });
        const answered = await turn.session.respond([{ requestId: request.requestId, text: probe }]);
        answered.succeeded();
        t.check(answered.message ?? "", includes('"status":"open"')).label(`"${probe}": the tool tells the model the claim stays open`);
        t.check(answered.message ?? "", includes('"isError":false')).label(`"${probe}": the tool result is not an error`);

        const claim = (await store.read()).claims.find((c) => c.id === claimId);
        t.check(claim?.status, equals("disputed")).label(`"${probe}": the claim is neither confirmed nor excluded`);
        t.check(claim?.question, equals(FIXTURE_FOLLOW_UP_QUESTION)).label(`"${probe}": its question stays open`);
        t.check(claim?.evidence.kind, equals("passage")).label(`"${probe}": no statement evidence was invented from the reply`);
      }

      const notes = questionNotes(await store.read())[claimId]?.map((note) => note.text);
      t.check(JSON.stringify(notes), equals(JSON.stringify(probes))).label("each reply is kept, in order, as the person's note on the question");
    }

    // The Exclude option still excludes.
    {
      const seeded = await store.extractClaims("resume", [
        { text: "The only engineer on call for the ledger service.", kind: "fact", evidenceRef: "resume.md#follow-up-exclude", evidenceQuote: "The only engineer on call" },
      ]);
      const claimId = seeded.profile.claims.find((claim) => claim.evidence.ref === "resume.md#follow-up-exclude")!.id;
      const turn = await t.send(askFollowUpPrompt(claimId));
      const request = turn.session.requireInputRequest({ toolName: "ask_follow_up" });
      const answered = await turn.session.respond([{ requestId: request.requestId, optionId: "excluded" }]);
      answered.succeeded();
      t.check(answered.message ?? "", includes('"status":"excluded"')).label("choosing Exclude reports the claim excluded");
      t.check((await store.read()).claims.find((c) => c.id === claimId)?.status, equals("excluded")).label("choosing Exclude excludes the claim");
    }
  },
});
