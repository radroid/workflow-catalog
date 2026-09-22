# iter 002 — P01 contracts ∥ P02 spike ∥ P09-A catalog

Date: 2026-09-22 · Phase 1 · Wave plan iteration 2

## What ran
- **P02 spike** (Opus, scratch dir /tmp/wc-eve-spike, no repo writes). **Mode A** (`eve build && eve start`): `chatgpt("gpt-5.6-luna")` completed turns through Codex-owned credentials, `httpBasic()` failed closed, and a `* * * * *` schedule fired unattended. Mode B passed too. eve's default slug `gpt-5.6-luna-fast` is rejected (HTTP 400) for a ChatGPT account. Verbatim: `docs/spec/research/eve-spike.md`.
- **P01** (Sonnet, PR #3): 18 zod contracts and emitted JSON Schemas, `workflow.json`, 8 SKILL.md prompts, 3 templates, fictional fixtures including the hostile posting.
  - Round 1: REVISE, 9 issues (consumer imports broke `next build`, URL rule lost in JSON Schema, missing P04 fields and `closed` status, skills missing data-not-instructions lines, UTF-16 cap).
  - Round 2: REVISE, 3 low issues. Escalated to an Opus implementer, since the Sonnet one had used its revision round.
  - Round 3: **APPROVE**. Merged as 18dcf02.
- **P09-A** (Sonnet, PR #4): invite sign-in (hashed single-use tokens, five structural slots, HMAC session cookies, `proxy.ts` plus DB checks), install guide with a persisted checklist and privacy statement, session-gated docs/learn, light and dark themes. Lighthouse accessibility: Home 100, Install 100.
  - Round 1: reviewer REVISE (3), UI critic REVISE (4), including learn pages returning HTTP 500 for signed-in users and a raceable invite cap.
  - Round 2: reviewer **APPROVE**; UI critic REVISE (1, dev-only stale PGlite instance). Merged as 3d64f23; the new issue goes to P09-B.

## Orchestrator decisions (logged in blocks.md)
- `CareerProfile.presentation[]` holds wording rules (from the walkthrough). Claim evidence stays single; answers become statement evidence. `Application.revision` is the task revision.
- Spec F2: the checksum comes from the release asset, not `workflow.json`.
- Spec §8, ARCHITECTURE §2 and CLAUDE.md now record mode A and the spike's conditions.
- New packet **P01.1** (contracts follow-ups: URL parity, pair-code cap, always-ask fixtures), scheduled before P03.
- Catalog deploy (Vercel project, Neon, Deployment Protection, preview URL) is owner-gated and listed in GOALS Open dependencies.

## Smoke test (integrated branch, 18dcf02 plus bookkeeping)
`pnpm typecheck` 0 · `pnpm test` 0 (contracts 224, catalog 87, job-assistant 122, scripts 2) · `pnpm lint` 0 · `pnpm check:fixtures` 0.

## PRs
#3 P01 merged · #4 P09-A merged · #2 integration PR updated.

## Blocks
Open: catalog deploy (owner-gated). Carried to iter-003:
- P09-B must fix the PGlite `globalThis` issue and the `__proto__` error lookup first.
- P02 must pin an explicit model slug, treat logs and `.eve/` as personal data, and control `eve init`'s quirks.
