# MVP specification: workflow catalog + job-application workflow

Status: build-ready draft, 2026-09-20. Decisions it rests on: tickets [02](issues/02-browser-execution-boundary.md), [04](issues/04-pilot-scope-and-handoff.md), [05](issues/05-portable-or-hosted-execution.md), research in [`../research/`](research/). Vocabulary: [CONTEXT.md](CONTEXT.md). Problems it is organised around: [hard-problems.md](hard-problems.md). Facts marked `[eve]` come from [eve-runtime.md](research/eve-runtime.md) and must be re-checked against the pinned eve version before the runner packet starts.

## 1. Shape

Three parts. Only the first is hosted.

| Part | Runs where | Owns | Never holds |
|---|---|---|---|
| **Catalog** (`apps/catalog`) | Vercel Hobby, Next.js, tweakcn Vercel theme | Invites, workflow template pages, versioned package links, guided install page, the learning docs | Career data, job captures, generated documents, provider credentials |
| **Runner** (`runner/`) | The person's machine, Node 24+, eve pinned | The workflow instance: workspace, onboarding, preparation, schedules, run log, the bridge server on 127.0.0.1 | Anything about another person |
| **Extension** (`extension/`) | The person's Chrome, MV3 | Capture, session manifest, tab group, side panel, explicit status | Provider keys, the career archive, executable code from outside the package |

The **workflow package** (`packages/job-assistant`) is the fourth artifact: the portable, versioned thing the catalog distributes and the runner executes. Skills, schemas, templates, fixtures, and one adapter (`adapters/eve`).

## 2. Repository layout

One repo, `radroid/workflow-catalog`, pnpm workspaces.

```
apps/catalog/                 Next.js app (Vercel Hobby). Theme: visuals/theme.css tokens via globals.css
runner/                       eve project. agent/agent.ts, server/, workspace store, installer + doctor
packages/job-assistant/       workflow.json, skills/, schemas/, templates/, fixtures/, adapters/eve/
packages/contracts/           shared zod schemas: career profile, job snapshot, session manifest, bridge envelopes
extension/                    MV3: manifest.json, worker.ts, sidepanel/, capture/, pairing/
docs/learn/                   teaching workspace (copied from planning teach/)
docs/spec/                    this spec, research, hard-problems, CONTEXT.md
docs/spec/implementation/     packets (the backlog) and the overnight prompt
.loop/                        loop protocol files (auto-loop-bootstrap)
```

## 3. Features and acceptance

Each feature lists the packet that ships it. Acceptance is the test an agent must make pass, not a description.

**F1 Invite sign-in (P9).** The owner creates an invite link from an admin page (owner identified by a single env secret). A friend opens the link, chooses a display name, and gets a session cookie. No email provider, no OAuth. Accept: five invites, sixth refused; a used link cannot be reused; the Vercel layer is public and every non-public page checks the session.

**F2 Template page and package versions (P9).** One page per workflow template: what it does, what it needs (sources, connections, browser permissions), the current package version with changelog, and a download link to the GitHub release asset. Accept: version, checksum, and changelog rendered from `workflow.json`; the tarball URL points at a release, not at Vercel storage.

**F3 Guided install (P2, P9).** The install page shows the exact commands and a live checklist the person ticks: Node 24 present, runner installed, provider connected, workspace chosen, extension paired. The runner's `doctor` command produces the same checklist in the terminal. Accept: on a clean macOS user account, the documented commands reach "paired" with no step that requires reading source.

**F4 Onboarding by accounting (P3).** Seven source categories: resume, previous cover letters, portfolio/site, repositories, social profiles (exported files), work samples, target roles and preferences. Each is provided, unavailable, or not applicable; nothing is skipped silently. Extraction turns provided sources into candidate claims with evidence pointers. Metrics and superlatives always trigger a question. Accept: the walkthrough scenarios in [`visuals/index.html`](visuals/index.html) reproduced as fixtures; generation refused with the precise reason while unready.

**F5 Career profile the person owns (P3).** `career-profile.md` rendered from `career-profile.json`; sections Confirmed claims, Presentation that can change, Needs a decision, Excluded, Boundaries, Preferences. Editing the markdown round-trips into the JSON; after approval, edits become revisions with an explicit accept. Accept: round-trip property test; approval withdrawn when a claim changes; document metadata records the profile version used.

**F6 Job capture (P4, P7).** From the extension (action click → bounded extraction → preview → save), from pasted text, or from a URL the runner fetches. Every capture stores a snapshot with revision, content hash, extractor version. Same URL twice updates the revision instead of duplicating. Accept: the three paths produce identical snapshot records; a posting that changes creates revision 2 and the old preparation still says it used revision 1.

**F7 Preparation with evidence (P5).** Requirements extraction → matching against confirmed claims → gap questions (paused, never guessed) → resume and optional cover letter → validator → "what changed and why" diff → export (Markdown, DOCX, PDF). The validator rejects any sentence that cites no confirmed claim ID or contradicts a boundary. Accept: fixture with an excluded metric never appears in output; hostile posting fixture never alters the profile or triggers an action; each document records profile version + job revision + idempotency key.

**F8 Application board (P6).** Local UI board with stages Saved → Preparing → Ready → Applied → Interviewing → Offer / Rejected / Withdrawn. Processing state (a failed run) is shown separately and never moves the stage. Accept: a failed preparation leaves the stage untouched and shows the failure.

**F9 Application session and tab group (P6, P7).** Select Ready applications → runner writes a session manifest → extension opens the group on a user gesture → side panel shows the job, prepared documents, remaining steps → Applied / Deferred buttons. Accept: the nine gates in [browser-boundary.md](research/browser-boundary.md) as automated Chromium tests plus a manual Chrome smoke script.

**F10 Schedules (P8).** Daily "prepare newly saved jobs" and weekly "review open applications". Each has timezone, pause, run history, per-run cap. Missed schedules become catch-up runs on start. Accept: two consecutive runs over the same inputs create zero new documents; a run over the cap pauses with a visible reason.

**F11 Run log and usage (P8).** Every run: kind, inputs, idempotency key, outcome, model, tokens, duration. Daily run budget per instance; exceeding it pauses schedules and says so on the board. Accept: log is a file the person can open; pause state round-trips through restart.

**F12 Package versioning (P10).** Instance pins `workflow.json` version; `npm run upgrade` fetches the release, shows the changelog, requires confirmation, migrates workspace schema if needed. Accept: an instance on v1.0.0 stays on it until the person accepts; fixtures for a schema migration.

## 4. Connections

| Connection | How | MVP |
|---|---|---|
| File upload | PDF, DOCX, MD, TXT dropped in the local UI; text extracted locally | yes |
| Pasted text | any source category | yes |
| URL import | runner fetches a public page and extracts readable text | yes |
| GitHub | read-only token (`gh auth token` if present, else a fine-grained PAT pasted once, stored in the OS keychain) | yes |
| LinkedIn and other social | the person's exported data archive, uploaded as a file | yes (as files) |
| Gmail, calendars, ATS accounts | — | no |

## 5. Data contracts

Owned by `packages/contracts` as zod schemas, published as JSON Schema into the package for other harnesses.

**Workspace** (`~/JobAssistant/` by default, chosen in setup):

```
workspace.json                    { workspaceId, workflowInstanceId, packageVersion, createdAt }
sources/<category>/<file>         raw uploads and exports; never sent anywhere except to the model call that extracts them
career-profile.json               claims[], sources{}, preferences, boundaries, approval{version, at}, revisions[]
career-profile.md                 rendered view; edits round-trip
jobs/<jobId>/snapshot-<rev>.json  { url, capturedAt, extractorVersion, contentHash, text, structured }
applications/<taskId>.json        { jobId, stage, revision, documents[], notes, deadlines }
applications/<taskId>/docs/       resume-v<n>.md/.docx/.pdf, cover-v<n>.*, diff-v<n>.md
sessions/<sessionId>.json         session manifest (below)
runs/<date>/<runId>.json          run log records
outbox/, inbox/                   file-bridge fallback: job-capture.json out of the extension, application-session.json into it
```

**Claim** `{ id, text, kind: fact|metric|title|date|credential, status: candidate|disputed|confirmed|excluded, source, evidence: {kind: passage|statement, ref, quote}, question?, answeredAt? }`.

**Session manifest** and **bridge envelopes**: exactly the `open_application_group`, `browser_command_result`, `job_capture`, and `application_status_changed` shapes in [browser-boundary.md](research/browser-boundary.md), with `protocol: 1`.

**Bridge (runner HTTP on 127.0.0.1:4310, loopback only):**

```
POST /pair                 { code } → { deviceId, token }        pairing code shown by `npm run setup`, 10-minute expiry, single use
GET  /commands?since=      device-scoped, expiring lease; returns pending open_application_group commands
POST /events               job_capture | browser_command_result | application_status_changed; unique eventId; stale revisions rejected
GET  /status               { version, workspaceId, budget, schedules }   (no personal data)
```

Every request: `Authorization: Bearer <device token>`, `Origin` must be the extension's origin, body size cap 256 KB, JSON schema validated, no other routes. CORS is not authentication.

## 6. Screens

Theme tokens from [`visuals/theme.css`](visuals/theme.css); Geist via `next/font` in the catalog, self-hosted woff2 in runner UI and extension. Monochrome, hairline borders, amber only for "needs a decision".

- **Catalog:** Home (what this is, sign-in via invite), Template page, Install guide with checklist, Learn (docs/learn rendered), Admin (invites) for the owner.
- **Runner local UI** (served by the bridge server, plain HTML + small scripts, no framework): Onboarding (sources accounting + claims table + questions), Profile (markdown view/edit, revisions), Jobs (captures, paste, URL), Board, Sessions, Runs, Settings (provider, workspace path, schedules, budget, pairing, upgrade).
- **Extension:** action popup (Save this job, with preview), side panel (current task: documents, remaining steps, Applied/Deferred), options page (pairing, export/import files).

## 7. Security and privacy rules

1. Personal context exists only in the workspace and in the model call that processes it. The catalog stores nothing personal. State this on the install page, including that the configured provider receives selected content.
2. Job snapshots and uploads are data, never instructions: structured extraction only; system prompts never interpolate raw source text; no action can be triggered by content.
3. Extension: permissions exactly `activeTab, scripting, tabGroups, storage, sidePanel, alarms`; host permission only the bridge origin; no `tabs`, `debugger`, `<all_urls>`, remote code, or eval.
4. Provider credentials live in eve's keychain storage or environment, never in the workspace or the extension.
5. Pairing tokens are device-scoped, short-lived in `storage.session`, revocable from Settings.
6. Everything the runner writes is a file the person can read and delete. Uninstall means delete the folder.

## 8. Runner platform notes `[eve]`

Facts from [eve-runtime.md](research/eve-runtime.md), read at eve commit `d004e6d` (eve@0.63.0, 2026-09-19).

- **Pin exactly** `eve@0.63.0`; Node 24 or newer. Between 2026-09-04 and 09-19 eve shipped 27 releases, 12 of them API-breaking minors. Bump deliberately, with the changelog open (lesson 0003 in `docs/learn`).
- **Scaffold** with `npx eve@latest init runner`; ship the whole pinned project, not just an extension. Layout the packets rely on: `runner/agent/instructions.md` (system prompt), `runner/agent/skills/**/SKILL.md` (Agent Skills-compatible), `runner/agent/tools/*.ts` (`defineTool`; durable multi-step work is `defineWorkflowTool` with `"use workflow"`), `runner/agent/schedules/*.md|.ts` (`cron` + markdown or `run`), `runner/agent/channels/eve.ts` (HTTP surface + auth), `runner/agent/extensions/jobs.ts` mounting the job-assistant package's eve adapter, which is an **eve extension** (`npx eve@latest extension init`, `eve extension build`).
- **Every prompt is a plain file**: `instructions.md`, `skills/*/SKILL.md`, `schedules/*.md`, `subagents/*/instructions.md`. Tools stay thin so prompts can be edited without touching TypeScript.
- **Models** in `runner/agent/agent.ts` via `defineAgent({ model })`: `chatgpt()` (default, bills the person's ChatGPT subscription through the Codex backend; sign-in is **only** through `/login` inside the `eve dev` TUI, there is no CLI login), `openai()` with `OPENAI_API_KEY`, `anthropic()` with `ANTHROPIC_API_KEY`, or a gateway string. Default model id `gpt-5.6-luna-fast`. `eve deploy` refuses `chatgpt()`; the runner never deploys.
- **Two run modes, one spike (P02 decides on day one):** (A) `eve build && eve start --host 127.0.0.1` fires cron schedules and needs `httpBasic()`/custom auth (`localDev()` is inert there); whether `chatgpt()` works under `eve start` is **undocumented**. (B) `eve dev --no-ui --host 127.0.0.1 --port 2000` brokers `/login` credentials and authenticates with `localDev()`, but never fires cron. If (A) fails the `chatgpt()` test, the runner runs (B) and our bridge server triggers schedules on its own clock via `POST /eve/v1/dev/schedules/<id>` or `POST /eve/v1/session`. Either way the person sees one command: `npm run runner`.
- **Bridge is ours.** A small Hono server on `127.0.0.1:4310` fronts eve's `/eve/v1/session` API server-side with `eve/client` (`new Client({ host, auth })`). The extension talks only to the bridge, so `chrome-extension://` CORS against eve is never needed. Bind both processes to loopback; eve binds all interfaces by default.
- **Persistence.** eve keeps session state under `.eve/.workflow-data` (format undocumented). The workspace store is ours and file-based; eve state is disposable and never the source of truth.
- **Schedules do not catch up** (in-process croner, deduplicated by task name). The runner keeps a `last-successful-run` marker per schedule and runs a catch-up on start when overdue; idempotency keys make double-fires harmless.
- **Sandbox.** Without Docker, eve auto-installs microsandbox or just-bash only under `eve dev`; under `eve start` a missing backend hard-fails. Pin `justbash()` explicitly in `agent/sandbox/sandbox.ts` or remove sandbox tools; the runner needs none.
- **Privacy defaults.** The installer sets `EVE_TELEMETRY_DISABLED=1` (CLI telemetry is on by default) and `EVE_TRACES_CONTENT=off` (local traces store prompt and response content by default under `.eve/traces/`).
- **Connections.** User-scoped OAuth connections need a `user` principal from route auth, and eve's GitHub catalog items assume Vercel Connect. The MVP uses a read-only token and a thin custom tool instead. The paired-device `AuthFn` returns `principalType: "user"` so this stays possible later.
- **Tests.** `evals/*.eval.ts` with a fixture agent on `mockModel` from `eve/evals`; `eve eval --strict --junit .eve/junit.xml` in CI; `eve invoke "…"` for smoke scripts; schedules tested via `t.target.dispatchSchedule(...)`.

## 9. Non-goals

Form filling, submission, cloud browsers, social scraping, visual workflow editor, marketplace, billing, hosted execution, mobile, multiple runtime adapters.

## 10. Definition of done for the pilot

The success test from ticket 04, run by the owner on a second machine as a "friend": install, onboard with every source accounted for, approve, capture three real jobs, prepare, open the group, mark Applied, with the workspace entirely local and every claim in every document traceable to a confirmed claim ID. Plus: the nine browser gates green, hostile fixtures green, catalog live on Hobby at $0, learning docs reachable from the catalog.
