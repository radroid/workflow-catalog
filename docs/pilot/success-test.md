# Pilot success test

The scripted run from ticket 04 (`docs/spec/issues/04-pilot-scope-and-handoff.md`)
and spec §10: an invited friend installs on their own machine, with their own
model provider, accounts for every source category, resolves or excludes
every candidate claim, approves their career profile, captures three real
jobs, gets prepared resumes where every claim traces to a confirmed claim
ID, opens the tab group, and marks applications Applied — workspace entirely
local throughout. This checklist adds the schedule/catch-up, budget-pause and
forget steps that round out spec §10's "definition of done for the pilot",
so the owner can run the whole thing, once, on a second machine.

Ticket 04's ~30-minute figure covers install through approving the career
profile (steps 1–8 below). The rest — three captures, three preparations, a
session, and the schedule/budget/forget checks — takes longer; expect
60–90 minutes end to end for a first run.

Run every numbered step in order. Each names the exact command or click, what
you should see, and a rough time. A step that fails is a `blocked` note in
this file (or the packet that owns the broken piece), never a silent skip.

## Before you start: owner-gated steps and their fallback

Three things in the normal flow are gated to the project owner and are not
done yet. Each has a fallback used by this checklist instead — not a
lesser path, since it's also the one path actually tested so far:

- **The catalog deploy.** `apps/catalog/README.md`'s "Owner-gated deploy
  steps" is still open, so there is no live catalog to sign in to and click
  through. **Fallback:** clone the repo and follow `runner/README.md`
  directly (steps 1–3 below) — this is already how the tested install path
  works; the catalog's `/install` page would only mirror the same commands.
- **The first release tag** (`job-assistant@0.1.0`). Nobody has pushed it, so
  the catalog's template page (`/templates/job-assistant`) has no checksum or
  download link yet (`apps/catalog/README.md`, "Template page and package
  releases"). **Fallback:** the whole-repo clone in step 1 already contains
  the package at its pinned workspace version; there is nothing to
  separately download.
- **The Chrome Web Store listing.** Not published (`browser-boundary.md`,
  "Distribution and verification": registration is a one-time fee, review
  timing isn't guaranteed). **Fallback:** Developer Mode → **Load unpacked**
  (step 5), which is also the only path used in CI and by every other
  packet's manual smoke test.
- **`overnight/integration` → `main` (PR #2).** Not merged yet, and
  `origin/main` is 116+ commits behind — it has no `runner/`, `extension/`
  or `docs/pilot/` at all. **Fallback:** step 1 clones
  `overnight/integration` explicitly instead of the default branch. Once
  PR #2 merges, drop `--branch overnight/integration` and clone normally.

## Checklist

1. **Clone and install.** Until PR #2 (`overnight/integration` → `main`)
   merges, `main` has no `runner/`, so clone the integration branch
   explicitly:
   ```sh
   git clone --branch overnight/integration https://github.com/radroid/workflow-catalog.git
   cd workflow-catalog
   corepack enable
   pnpm install --frozen-lockfile
   ```
   Once PR #2 has merged, drop `--branch overnight/integration` — a plain
   `git clone https://github.com/radroid/workflow-catalog.git` gets `main`,
   which then has everything.
   *Expect:* installs the pinned versions from the committed lockfile with no
   error. *Time:* ~3–5 min, mostly network.

2. **Set up the runner.**
   ```sh
   cd runner
   npm run setup
   ```
   Answer the prompts: workspace folder (default `~/JobAssistant`), model
   provider (`chatgpt`, `openai`, `anthropic`, or `gateway`). For ChatGPT,
   setup checks `codex login status` and tells you what to do if Codex is
   missing or signed out — sign in there, not through eve.
   *Expect:* `runner/.env.local` is written (mode `0600`), and setup prints a
   pairing code like `7KQ2M-X9RTB` (10 minutes, single use — if it expires
   before step 6, run `npm run pair` for a fresh one). *Time:* ~5 min, more
   if you need to sign in to Codex or a provider first.

3. **Doctor.**
   ```sh
   npm run doctor
   ```
   *Expect:* seven items (`node`, `runner`, `provider`, `workspace`,
   `extension`, `privacy`, `eve`), each `ok`/`warn`/`fail`. **`extension`
   shows `fail` ("No browser extension is paired.") until step 6 pairs a
   browser, and the command exits 1** — expected at this step, not a
   problem; every other required item should already be `ok`. `provider`
   warns until it's verified live. Run `npm run doctor -- --live` (or
   `npm run doctor --live`) to verify the model with one short call and
   clear that warning. *Time:* ~10 s, a few more seconds with `--live`.

4. **Start the runner.**
   ```sh
   npm run runner
   ```
   *Expect:* builds if needed (`eve extension build`, then `eve build`),
   then starts `eve start` on `127.0.0.1:3210` and the bridge on
   `127.0.0.1:4310`, both loopback only. The terminal prints a one-time
   local-UI sign-in link (`/ui/login?nonce=…`, 10 minutes, single use — get
   a fresh one any time with `npm run ui`). Leave this terminal running for
   the rest of the test; `Ctrl-C` stops both processes cleanly. *Time:*
   ~30 s–2 min on the first build, a few seconds on a later start.

   Open the sign-in link in a browser, then `http://127.0.0.1:4310/ui/status`
   to confirm: the doctor checklist mirrored, the model with a "Check the
   model" button, and the workspace path.

5. **Build and load the extension.**
   ```sh
   pnpm --filter @workflow-catalog/extension build
   ```
   Then in Chrome: `chrome://extensions` → enable **Developer mode** (top
   right) → **Load unpacked** → select `extension/dist`.
   *Expect:* the action icon appears in the toolbar. *Time:* ~3 min.

6. **Pair the extension.** Open the extension's options page (right-click
   the toolbar icon → **Extension options**), enter the pairing code from
   step 2, click **Pair**. *Expect:* a short device id appears, and the
   status section flips to connected with the runner's version and
   workspace. `npm run doctor` now shows `extension: ok`. *Time:* ~1 min.

7. **Onboarding — account for every source.** Open
   `http://127.0.0.1:4310/ui/onboarding`. For each source category, use
   whichever mode fits: paste text, upload a `.txt`/`.md`/`.pdf`/`.docx`
   file, import an exported `.zip` archive (LinkedIn and similar), fetch a
   public URL (portfolio or personal site), or connect GitHub (`gh auth
   token`, or a pasted fine-grained PAT kept in the OS keychain) — **the
   PDF/DOCX/zip/URL/GitHub modes land per P03.1**; until that packet merges,
   the page offers paste plus `.txt`/`.md` upload only. A source you can't
   or won't provide is marked unavailable or not applicable — that still
   counts as accounted for. Then, in the Claims section, decide each
   candidate claim: **Confirm** or **Exclude**. Confirming sometimes opens a
   follow-up question instead (badge "question open") when the runner wants
   more evidence — answer it with **Yes, I have evidence** (optionally
   adding your own statement) or **No, exclude it**. *Expect:* the Sources
   section shows every category accounted for, and every claim ends up
   **confirmed or excluded** — none left `candidate`, and none left with a
   question open (approval refuses while any is). *Time:* ~10–15 min,
   depending on how much material you bring.

8. **Approve the career profile.** Still on the Onboarding page, once every
   source is accounted for and every claim is confirmed or excluded, the
   **Approve career profile** button (in the Readiness card) stops being
   `aria-disabled`. Click it. *Expect:* the profile records an approval
   (`version`, `at`); `career-profile.md` is now readable at
   `http://127.0.0.1:4310/ui/profile`. *Time:* ~1 min.

9. **Capture three real jobs.** Repeat three times, for three different real
   postings: open the posting in a tab, click the extension's toolbar icon
   → the popup previews title/company/location/size/excerpt → **Save this
   job**. *Expect:* the status line says the runner has it (or it's queued,
   if not paired — resolve pairing first); `http://127.0.0.1:4310/ui/jobs`
   lists the job, and its structured fields (title, company, location,
   requirements, deadline, apply link) appear once extraction finishes. You
   can also paste a posting's text and address, or fetch an `https://` link,
   directly on the Jobs page. *Time:* ~2 min per job, including extraction.

10. **Prepare an application for each captured job.** Open
    `http://127.0.0.1:4310/ui/application`. First, under **Your name on
    the documents**, save the name and contact line your documents will
    carry (never sent to the model). Then, for each of the three jobs, pick
    it under **Prepare a saved job** and click **Prepare**. *Expect:* a
    resume (Markdown, DOCX, PDF) drafts from your confirmed claims only, and
    every sentence in "What changed and why" cites a claim label (`[C1]`,
    `[C2]`, …) that traces to a claim you confirmed in step 7 — spec §10's
    "every claim in every document traceable to a confirmed claim ID". A gap
    question parks preparation in amber instead of guessing; answer it (or
    exclude the evidence) and Prepare again. *Time:* ~2–5 min per
    application, mostly the model call.

11. **The board.** Open `http://127.0.0.1:4310/ui/board`. *Expect:* the
    three applications show under their stage, with a prepared, Ready
    application selectable under **Start applying**. Select the ones you
    want to open together and click **Start a session**. *Time:* ~1 min.

12. **A session: tab group, side panel, Applied** *(the side panel and
    tab-group behaviour land per P07-C; this step exercises them once that
    packet is merged)*. Open the extension's side panel. *Expect:* it polls
    `GET /commands` (on open, and again every 15 minutes via an alarm) and
    shows the pending session; a user click opens the group as a real
    Chrome tab group (one tab per application, named and coloured), never
    automatically from the alarm. For each task, the side panel shows the
    job, links to the prepared documents, remaining steps, and **Applied** /
    **Defer** buttons. Click **Applied** once you'd actually apply.
    *Expect:* the board's stage moves only from this explicit action (never
    from just closing the tab, which records only that the tab closed);
    `http://127.0.0.1:4310/ui/sessions` shows the session's manifest
    and each command's state. If no browser is paired, the same session
    manifest lands in `outbox/application-session.json` for the extension's
    file-bridge **import** instead. *Time:* ~5 min for a group of three.

13. **A schedule and its catch-up.** Open
    `http://127.0.0.1:4310/ui/settings`'s **Schedules** section.
    *Expect:* two cards, "Prepare newly saved jobs" (daily, 09:00 UTC) and
    "Review open applications" (weekly, Monday 09:00 UTC), each showing its
    next run and either "Last successful run …" or "No successful run yet".
    Catch-up isn't a separate command: every runner start (and every five
    minutes after) checks whether a schedule's current slot is overdue and,
    if so, claims and runs it once immediately. If step 4's `npm run runner`
    happened after 09:00 UTC that day, this already ran once, unannounced,
    before you did anything else — with 0 jobs prepared, since none were
    Saved yet at that point. To see a catch-up run with something in it:
    leave a job in the Saved stage (skip preparing it in step 10), stop the
    runner, and restart it after the schedule's fixed UTC time has passed —
    check `http://127.0.0.1:4310/ui/runs`, where the triggered run
    carries a "catch-up" badge, and the Schedules card's "Last successful
    run" advances. *Time:* ~2 min to read the cards; the once-a-day/week
    timing means forcing a *second* catch-up on demand isn't practical
    within one sitting.

14. **The budget pause.** Open Settings' **Budget** section. *Expect:* the
    daily run limit (default 10) and per-run item cap (default 5), runs used
    today, and Save. Two states to recognize, not force:
    - **Daily limit reached** (forceable): set the daily run limit to 1 and
      Save, then trigger two runs (for example, Prepare on two different
      Saved jobs). *Expect:* the second shows "Daily limit reached. New runs
      wait until tomorrow." below Save, and Prepare refuses at once, naming
      the limit. Set the limit back afterwards.
    - **Paused** (observational): a real provider rate-limit turns this into
      a stored pause — "Paused: …" with a Resume button — independent of the
      daily-limit state above. This only fires from an actual provider 429,
      so don't try to force it; if it happens during your pilot, click
      **Resume** and confirm the note "Runs resumed with the default
      limits…" (or "Runs resumed.", if you'd changed the limits and saved
      since).
    *Time:* ~5 min for the forceable case.

15. **Forget.**
    ```sh
    npm run setup -- --forget
    ```
    Add `--dry-run` first to only list what would be removed, without
    changing anything. *Expect:* lists, then (after confirmation, or with
    `--yes`) removes `runner/.env.local`, `runner/.eve/`, `runner/.output/`,
    `runner/.nitro/`, `eval-agent/.eve/` and `.output/`, the runner's own
    keychain entries, and the workspace folder (unless you pass
    `--keep-workspace`) — only when its `workspace.json` is still valid. It
    separately asks (default no; `--yes` never answers yes for you) about
    eve's own sign-in, shared by every eve project on the machine; leave
    that alone unless you mean to sign out of Codex/eve everywhere. *Time:*
    ~1 min.

## After the checklist

Confirm, from spec §10: every claim in every document traces to a confirmed
claim ID (checked live in step 10); the workspace never left the machine
(`docs/pilot/privacy-checklist.md`); and any step that didn't go as written
above is recorded as a blocked note here, not silently skipped.
