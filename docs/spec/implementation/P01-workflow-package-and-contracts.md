# P01 · Workflow package and shared contracts

Status: claimed
Assignee: iter-002 implementer (Sonnet)
Blocked by: P00
Owns: packages/job-assistant/, packages/contracts/
Spec: §5 data contracts, F12 (manifest only), execution-options.md package layout

## Goal
The portable, versioned workflow package and the zod contracts every other part imports. Provider-neutral; the eve adapter is a stub here (P02 fills it).

## Deliverables
- `packages/contracts/src/`: zod schemas + inferred types for Claim, CareerProfile, Source, JobSnapshot, Application, SessionManifest, RunRecord, and the four bridge envelopes (`open_application_group`, `browser_command_result`, `job_capture`, `application_status_changed`, `protocol: 1`). `pnpm --filter contracts build` also emits JSON Schema to `packages/job-assistant/schemas/`.
- `packages/job-assistant/workflow.json`: name, version `0.1.0`, description, required sources (seven categories), connections, browser permissions (the six), actions allowlist (`capture_job`, `open_application_group`, `report_status`), schemas list, adapters list (`eve`), changelog entry.
- `packages/job-assistant/skills/`: `SKILL.md` files (Agent Skills frontmatter: `name`, `description`) for `onboarding-accounting`, `claim-extraction`, `follow-up-questions`, `requirements-extraction`, `claim-matching`, `resume-drafting`, `cover-letter-drafting`, `revision-diff`. Each states inputs, outputs (by schema name), boundaries, and what it must never do. Prompts only; no code.
- `packages/job-assistant/templates/`: `career-profile.md.hbs`, `resume.md.hbs`, `cover-letter.md.hbs`.
- `packages/job-assistant/fixtures/`: fictional resume, cover letter, portfolio text, repo summary, LinkedIn-style export, three job postings (one hostile: contains "ignore previous instructions" and a fake action request), expected claims for the resume, expected excluded metric.
- `packages/job-assistant/adapters/eve/README.md`: how P02 will mount this as an eve extension.

## Acceptance
- Contract tests: every fixture validates against its schema; a hostile posting validates as a JobSnapshot (it is data) and contains no field that could be mistaken for an action.
- `workflow.json` validates against `schemas/workflow.schema.json`; version is semver.
- Every `SKILL.md` has frontmatter `description` (eve requires it) and a "Never" section.

## Out of scope
Any model call. Any runner code.

## Report

### 2026-09-22 — iter-002 implementer (Sonnet)

**What was done.** Everything in Deliverables/Acceptance above, plus a couple of
supporting-infrastructure pieces the spec implied but didn't spell out:

- `packages/contracts/src/`: `primitives.ts` (uuid/httpUrl/isoDateTime/isoDate/semver/hexDigest
  helpers) plus one file per schema — `claim.ts`, `source.ts`, `career-profile.ts`,
  `workspace.ts`, `job-snapshot.ts`, `application.ts`, `session.ts`, `run.ts`,
  `bridge-envelopes.ts` (the four envelopes), `bridge-http.ts` (the five bridge
  bodies), `workflow-manifest.ts`. `registry.ts` lists all 18 schemas the build
  emits; `index.ts` re-exports everything (barrel).
- `scripts/emit-schemas.mjs` (plain JS, not TS — see assumption on `.js`
  extensions below) runs as `pnpm --filter contracts build`'s second step and
  writes `packages/job-assistant/schemas/*.schema.json` via zod 4's
  `z.toJSONSchema(schema, { target: "draft-2020-12" })`, skipping the write
  when content is unchanged so `build` never dirties mtimes.
- `packages/contracts/src/schema-drift.test.ts`: regenerates every schema
  in memory straight from `src` (via Vite's resolver, not a build) and
  byte-compares against the committed file, plus asserts the committed
  file set exactly matches `SCHEMA_REGISTRY`.
- One `*.test.ts` per contracts schema (14 files, 135 tests): valid-shape
  acceptance, strict rejection of unknown/injected keys, required-field
  enforcement, and each schema's specific rule (all seven sources required
  with no default; `job-snapshot.test.ts`'s hostile-content proof; bridge
  events carry no client-supplied `deviceId`; group-size cap; `scheduleKind`
  ⊂ `runKind`; workflow-manifest allowlists + no-duplicate arrays; `/status`
  has no personal-data field).
- `packages/job-assistant/`: `workflow.json`, 8 `skills/*/SKILL.md`, 3
  `templates/*.md.hbs`, `fixtures/` (resume, previous cover letter,
  portfolio text, repo summary, LinkedIn-style export, three `JobSnapshot`
  postings — Fernwood, Harbor, and one hostile — `expected-claims.json`
  (8 claims spanning all 5 `kind`s), `expected-excluded-metric.json`,
  `index.json`), `adapters/eve/README.md`, and `test/` (5 files, 68 tests:
  `workflow.test.ts` using ajv 8 `ajv/dist/2020` + `ajv-formats`,
  `fixtures.test.ts` walking `fixtures/index.json`, `skills.test.ts`,
  `templates.test.ts`, `package.test.ts`).
- Real `typecheck`/`test`/`lint` scripts and a `files` list on
  `packages/job-assistant/package.json`; added `ajv@8.20.0` and
  `ajv-formats@3.0.1` (both pure JS, no install-lifecycle scripts, no
  `pnpm-workspace.yaml` change needed) as devDependencies, plus
  `@workflow-catalog/contracts` (`workspace:*`) and `zod@4.5.4` as regular
  dependencies. Added `@types/node@24.13.6` to both packages' devDependencies.

**Tests run, real output.**
```
pnpm --filter contracts test    → 14 test files, 135 tests passed
pnpm --filter job-assistant test → 5 test files, 68 tests passed
pnpm -r typecheck                → all 5 non-placeholder scripts clean (tsc --noEmit)
pnpm -r lint                     → all clean (eslint --max-warnings 0)
pnpm typecheck && pnpm test      → green, including scripts/check-fixtures.test.mjs (2/2)
pnpm --filter contracts build    → tsc + emit-schemas.mjs, zero "wrote" lines
                                    (no drift against the last commit's schemas)
pnpm check:fixtures              → exit 0, no offenses
git status (after build)         → clean, no untracked/modified files
```
Full clean-clone re-verification (step 6.2 of this packet's instructions) is
queued for right after this report commit, alongside the push and PR.

**What was skipped, and why.**
- Actual Handlebars rendering of the three templates — the packet spec
  says this is "welcome but not required." Wrote a dependency-free,
  string-level smoke test instead (`templates.test.ts`: exact section
  headings present and in order, claim-citation markers present) rather
  than adding a `handlebars` dependency for a check the packet didn't
  require.
- No `disputed`-status example in the fixtures (only `candidate`,
  `confirmed`, `excluded` appear across `expected-claims.json`). `disputed`
  is exercised in `packages/contracts/src/claim.test.ts` instead; didn't
  see a natural, non-contrived way to add a disputed claim to Ada Quill's
  fixture resume without it reading as filler.
- No `allowBuilds` entry was needed — neither `ajv` nor `ajv-formats` has
  an install-lifecycle script.

**Assumptions (every modelling choice the spec left open).**
1. **`.js`-suffixed internal imports across `packages/contracts/src/`.**
   P00 shipped `index.ts` with no internal relative imports yet, so there
   was no established convention to follow. Plain `node` (used by the
   schema-emission script) requires an exact on-disk extension match for
   relative imports and does not do TypeScript's `moduleResolution:
   "Bundler"` extension inference; `tsc -p tsconfig.build.json` also can't
   accept literal `.ts` specifiers without `allowImportingTsExtensions`,
   which is incompatible with real (non-declaration-only) emit. Writing
   `from "./primitives.js"` (resolving to the sibling `.ts` file) satisfies
   both tsc's Bundler resolution *and* plain Node once compiled — confirmed
   empirically. Side effect: `packages/contracts/dist/index.js` is now
   directly runnable by plain Node, which it wasn't before.
2. **`emit-schemas.mjs` is plain JS, not TS**, and imports the *compiled*
   `../dist/registry.js` rather than `../src/registry.ts` — a plain `node`
   process can only resolve exact on-disk paths, and `dist/` is where
   those exist after step one of `build`. The drift test takes the
   opposite path (straight from `src`, via Vite) specifically so `pnpm
   test` alone — no build — still catches a stale schema.
3. **Source category keys are camelCase** (`resume`,
   `previousCoverLetters`, `portfolioSite`, `repositories`,
   `socialProfiles`, `workSamples`, `targetRolesAndPreferences`) — the
   packet spec named these in prose, not as literal identifiers. The one
   literal the spec *did* give in backticks — `provided | unavailable |
   not_applicable` — is honored verbatim, snake_case included, even though
   it's inconsistent with the rest of the contracts' camelCase.
4. **`Claim.source`** is typed as the `SourceCategory` enum (one of the
   seven), not a free string, so every claim traces to a real accounting
   category.
5. **`CareerProfile.preferences`/`boundaries`** are arrays of `{ id, text
   }` (`profileStatementSchema`), not bare strings — mirrors claims' own
   id+text shape so a revision or template can cite a specific entry,
   matching the "every claim rendered with its ID so P03 can round-trip
   it" requirement extended to these two fields. Worth P03 revisiting.
6. **`CareerProfile.approval.version`** is a plain positive-integer
   counter (the profile's own revision number), distinct from
   `workflow.json`'s semver package version. **`CareerProfileRevision`**
   (`{ id, summary, proposedAt, status: proposed|accepted|rejected,
   resultingVersion?, decidedAt? }`) is invented from CONTEXT.md's prose
   definition; spec gives no field list.
7. **`Application.documents[]`** entries carry `profileVersion`,
   `jobRevision`, and `idempotencyKey` *per document* (F7: "each document
   records profile version + job revision + idempotency key") rather than
   once per `Application`, since a single application can accumulate
   multiple prepared documents across preparation runs.
8. **`Application.processing`** is a nested object (`status:
   idle|running|failed`, optional `runId`/`error`) rather than flattened
   fields, specifically so there is no `stage` value a failed run could
   ever set — F8's "never moves the stage" holds by construction.
9. **`RunRecord.kind`** is `prepare_newly_saved_jobs | review_open_applications
   | manual` (a flat enum, not derived from `scheduleKindSchema` via
   `z.union`, so its JSON Schema is a plain `enum` rather than `anyOf`);
   `isCatchUp: boolean` is a separate field rather than a fourth `kind`
   value, and `outcome` adds `paused` alongside `success`/`failure` for a
   run skipped by the budget cap. `run.test.ts` asserts every
   `scheduleKind` is a `runKind` so the two can't silently diverge.
10. **Bridge envelope `deviceId` is deliberately absent** from the three
    `/events` bodies (`JobCapture`, `BrowserCommandResult`,
    `ApplicationStatusChanged`) — mvp-spec §5 says every bridge request
    carries `Authorization: Bearer <device token>`, and browser-boundary.md
    says "server derives identity from authentication," so a body-level
    `deviceId` the server merely trusted would let one paired device claim
    to be another. Kept only on `OpenApplicationGroup` (runner → extension,
    matching browser-boundary.md's own illustrative JSON). **P02 should
    treat this as load-bearing**, not incidental: the bridge server must
    derive the acting device from the auth header, never from a request
    body field.
11. All three `/events` envelopes standardize on **`occurredAt`** as their
    timestamp field name (browser-boundary.md's own JSON uses it for
    `browser_command_result`; `job_capture`'s spec prose just says
    "timestamp" generically).
12. **`application_status_changed.status`** is exactly `applied |
    deferred` — the side panel's two buttons (F9) — not the full
    `Application.stage` enum. `"deferred"` is a non-mutating signal by
    construction; only `"applied"` advances `stage`.
13. **`MAX_APPLICATION_GROUP_SIZE = 20`** and **bounded-text caps of
    200,000 chars** (`JobSnapshot.text`, `JobCapture.text`) are arbitrary
    numbers chosen to be clearly-bounded-but-generous; browser-boundary.md
    requires *a* cap but names none. Real caps are a product decision for
    whoever owns F6/F9.
14. **`contentHash`** is a generic hex-digest string
    (`/^[0-9a-fA-F]{8,}$/`), not pinned to a specific algorithm/length —
    the fixtures use real sha256 (verified by recomputation in a scratch
    check during authoring), but the schema doesn't enforce that choice.
15. **`WorkspaceManifest.workspaceId`/`workflowInstanceId`** are generic
    non-empty strings, not UUIDs — browser-boundary.md's "use durable
    UUIDs" guidance names application/session/device/command records
    specifically, not these two, and they never cross the bridge.
16. **`BudgetStatus`/`ScheduleStatus`** inner shapes (`dailyRunLimit`,
    `runsUsedToday`, `paused`, `pausedReason?`; `id`, `kind`, `paused`,
    `nextRunAt?`, `lastRunAt?`) are invented — mvp-spec §5 gives only the
    outer `StatusResponse` field names.
17. **`workflow.json`'s schema allows any *subset*** of the allowlisted
    `browserPermissions`/`actions`/`requiredSources` values (not the full
    exact set) — the packet's acceptance criteria separate "validates
    against the schema" from "permissions and actions equal those exact
    sets" as two different checks, so the exact-set requirement is
    enforced as a data-level test against the real `workflow.json`
    (`workflow.test.ts`), not baked into the type. All six allowlist-style
    arrays in `workflow-manifest.ts` additionally reject duplicate entries.
18. **Template render context is a view-model**, not the raw
    `CareerProfile` shape — the caller pre-partitions `claims[]` into
    `confirmedClaims`/`presentationClaims`/`needsDecisionClaims`/`excludedClaims`
    before rendering. Documented in an HTML comment at the top of
    `career-profile.md.hbs`. See "one thing to sharpen" below.
19. **`resume.md.hbs`/`cover-letter.md.hbs` need a `person: { name, contact
    }`** supplied by the caller — P01 defines no identity/contact schema
    anywhere (`CareerProfile` has none), so this can't come from a
    contract type yet.

**The one thing to sharpen in this packet next time.** `career-profile.md.hbs`'s
required "Presentation that can change" section has no corresponding
concept in `claimSchema`'s actual state machine (`candidate | disputed |
confirmed | excluded`) — it's not a `ClaimStatus` value, so nothing in the
zod schema marks which confirmed claims belong there. Whoever builds the
renderer (P03) will need to either add a field to `Claim` (e.g. a
`presentationAdjustable: boolean`, which would be a contracts change) or
derive the section some other way that isn't yet specified anywhere. This
packet noticed the gap (see assumption 18) but didn't close it, since doing
so felt like guessing at a product decision rather than a contract
mechanics question — flagging it explicitly so it isn't rediscovered cold
partway through P03.
