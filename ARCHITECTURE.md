# ARCHITECTURE.md

Canonical architecture for `workflow-catalog`. The autonomous build loop reads this file every iter (section-scoped) before picking work. The full contracts live in `docs/spec/mvp-spec.md`; this file is the index and the one-screen summary. Vocabulary: `docs/spec/CONTEXT.md`. The seven problems the design is organised around: `docs/spec/hard-problems.md`.

## Table of contents

1. [Domain summary](#1-domain-summary)
2. [Tech stack](#2-tech-stack)
3. [System diagram](#3-system-diagram)
4. [Data model](#4-data-model)
5. [Key flows](#5-key-flows)
6. [Non-goals](#6-non-goals)

## 1. Domain summary

An invite-only **catalog** shares reusable agent **workflow templates** with a five-person, noncommercial pilot. The first template is a job-application assistant: a person accounts for every source of their career information, confirms or excludes each extracted **claim**, approves a **career profile** they own as a file, captures job postings from the browser, gets prepared resumes in which every statement traces to a confirmed claim ID, and works through applications as a Chrome tab group with explicit Applied/Deferred status.

Execution is never hosted. Each person installs a versioned **workflow package** from the catalog into a **local runner** on their own machine with their own model access (ChatGPT subscription via `chatgpt()` or an API key). The catalog holds invites, template pages, package links, the install guide, and the learning docs, and never any personal data. Spec: `docs/spec/mvp-spec.md` §1 (shape), §3 (features F1–F12 with acceptance).

## 2. Tech stack

- pnpm workspaces, one repo: `apps/catalog`, `runner`, `packages/job-assistant`, `packages/contracts`, `extension`, `docs`. Layout: spec §2.
- **Catalog:** Next.js on Vercel Hobby (target $0/month, ceiling $25), tweakcn Vercel theme tokens from `docs/spec/visuals/theme.css`, Geist via `next/font`; invite sign-in with a session cookie, no email provider, no OAuth; Neon free tier for invites (P09). Packages ship as GitHub release assets, not Vercel storage.
- **Runner:** eve pinned exactly at `0.63.0`, Node 24 or newer; bridge server on `127.0.0.1:4310`; plain-HTML local UI served by the bridge; provider credentials in eve's keychain storage or environment. Facts: `docs/spec/research/eve-runtime.md`, budget: `docs/spec/research/runtime-budget.md`.
- **Extension:** Chrome MV3; permissions exactly `activeTab, scripting, tabGroups, storage, sidePanel, alarms`; host permission only the bridge origin. Boundary: `docs/spec/research/browser-boundary.md`.
- **Contracts:** `packages/contracts` owns every shape as zod schemas, published as JSON Schema into the package for other harnesses.
- **Package:** `packages/job-assistant` = `workflow.json`, `skills/`, `schemas/`, `templates/`, `fixtures/`, one adapter `adapters/eve`. Fictional fixtures only: `docs/spec/implementation/fixtures-policy.md`.

## 3. System diagram

```
   Vercel Hobby                        the person's machine                       the person's Chrome
 ┌─────────────────┐  package tarball  ┌────────────────────────────────┐  loopback  ┌──────────────────┐
 │ Catalog         │ ───(GH release)──▶│ Runner (eve@0.63.0, Node 24)   │◀──────────▶│ Extension (MV3)  │
 │ invites, pages, │                   │ workspace ~/JobAssistant/      │ 127.0.0.1  │ capture, side    │
 │ install guide,  │                   │ onboarding · preparation ·     │  :4310     │ panel, tab group │
 │ docs/learn      │                   │ board · schedules · run log    │  bearer    │ Applied/Deferred │
 └─────────────────┘                   │ bridge server (4 routes)       │  token     └──────────────────┘
   holds nothing personal              └──────────────┬─────────────────┘           file import/export
                                                      │ the person's own provider    fallback (outbox/inbox)
                                                      ▼
                                          ChatGPT subscription or API key
```

## 4. Data model

Owned by `packages/contracts`; full shapes in spec §5. Main entities:

- **Workflow template / package / instance** — the shareable definition, its versioned distributable, and one person's private adoption (`workspace.json`: workspaceId, workflowInstanceId, packageVersion).
- **Invite** — the owner's grant for one named person; five invites, a used link cannot be reused (F1).
- **Source** — a career-information category marked provided, unavailable, or not applicable; raw files under `sources/<category>/`.
- **Claim** — `{ id, text, kind, status: candidate|disputed|confirmed|excluded, source, evidence }`; the unit every generated statement must cite.
- **Career profile** — `career-profile.json` (claims, sources, preferences, boundaries, approval, revisions) with a round-tripping `career-profile.md` view. **Readiness** = every source accounted for, no candidate or disputed claim, profile approved.
- **Job snapshot** — `jobs/<jobId>/snapshot-<rev>.json`: url, capturedAt, extractorVersion, contentHash, text, structured.
- **Application** — `applications/<taskId>.json` (stage, revision, documents, notes, deadlines) plus generated documents and diffs.
- **Session manifest** and **bridge envelopes** — `open_application_group`, `browser_command_result`, `job_capture`, `application_status_changed`, `protocol: 1`.
- **Run log** — `runs/<date>/<runId>.json`; budget pause and schedules read from it.

## 5. Key flows

Each flow names the packet that ships it; acceptance lives in the packet and spec §3. Walkthrough prototype of the onboarding scenarios: `docs/spec/visuals/index.html`.

### Flow 1 — Install from the catalog (P09, P02)
1. Owner creates an invite link; friend opens it, picks a display name, gets a session cookie.
2. Template page shows version, checksum, changelog from `workflow.json`; download points at a GitHub release asset.
3. Guided install: runner setup chooses workspace path and provider, `doctor` verifies, pairing code shown for the extension.

### Flow 2 — Own the career profile (P03)
1. Person accounts for every source (file, paste, URL, GitHub token, exported archives).
2. Extraction yields candidate claims with evidence; person confirms, disputes, or excludes each; open questions are answered.
3. Readiness lock: generation is refused until ready; approval stamps `approval{version, at}`; edits create revisions.

### Flow 3 — Capture a job (P04, P07)
1. Extension action "Save this job" (or paste / URL in the local UI) produces a snapshot with a content hash; hostile content is data only.
2. Extension posts `job_capture` to the bridge with a device token; file-bridge fallback via `outbox/`.

### Flow 4 — Prepare with evidence (P05, P08)
1. For a job, the runner drafts resume and cover documents; every claim used carries a confirmed claim ID.
2. The citation validator rejects any statement without a confirmed source; excluded claims never appear; a diff against the prior version is written.
3. Runs are logged; the budget pause halts scheduled work at the cap; daily schedule catches up after missed days.

### Flow 5 — Apply as a tab group (P06, P07)
1. Board moves an application through stages; a session manifest lists documents and steps.
2. Extension receives `open_application_group`, opens the tab group and side panel; the person fills forms themselves.
3. Explicit Applied / Deferred posts `application_status_changed`; stale revisions are rejected. The nine browser gates: `docs/spec/research/browser-boundary.md`.

## 6. Non-goals

Spec §9 and the brief: no form filling or submission, no cloud browsers, no social scraping, no visual workflow editor, no marketplace, no billing, no hosted execution, no mobile, no second runtime adapter, no Gmail/calendar/ATS connections. The loop must not pursue any of these.
