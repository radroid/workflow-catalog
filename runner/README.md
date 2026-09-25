# @workflow-catalog/runner

The job-assistant runner: a pinned eve agent that runs on the person's own
computer with their own model provider, plus the **bridge**, a small HTTP
server on `127.0.0.1:4310` that the Chrome extension and the runner's local
UI talk to. Everything the runner keeps about the person is a file in their
workspace folder.

- eve **0.63.0**, pinned exactly (no caret) here, in the adapter and in the
  eval fixture. `npm run doctor` checks the pin. Bump deliberately, with the
  changelog open (mvp-spec §8).
- Node **24** or newer.
- Facts about eve come from `docs/spec/research/eve-runtime.md`,
  `docs/spec/research/eve-spike.md` and `node_modules/eve/docs`, never from
  memory.

## Run mode: A (`eve build` + `eve start`)

Decided by the P02 spike (`docs/spec/research/eve-spike.md`). `npm run
runner` builds when needed, then starts `eve start --host 127.0.0.1 --port
3210` and the bridge on `127.0.0.1:4310`. The person runs one command. In
mode A, `eve start` can fire its own cron schedules (the spike proved a
`* * * * *` schedule fires and completes on its own) — but P08-B's two
schedules don't use that mechanism; see "Schedules and catch-up" below for
why. `chatgpt()` completes turns with the sign-in that Codex owns.

Mode A holds only under four conditions, and the runner enforces each:

1. **An explicit model slug the account accepts.** eve's default,
   `gpt-5.6-luna-fast`, is rejected for ChatGPT accounts. Setup records a
   slug (it suggests `gpt-5.6-luna`), and `doctor` reports whether it was
   verified.
2. **`codex` on eve's PATH.** `chatgpt()` spawns `codex app-server` from
   the server's PATH. Setup records codex's directory as `RUNNER_CODEX_DIR`,
   and the launcher puts it first on eve's PATH.
3. **The adapter builds before the agent.** `eve extension build` runs
   before `eve build`; the launcher does both.
4. **One mode per `.eve/` directory.** Never alternate modes on it: do not
   run `eve dev` inside `runner/`.

Mode B (`eve dev --no-ui`, with the bridge triggering schedules) passed the
same test and stays the fallback.

eve reads the model at runtime (`agent/lib/model.ts`), but its build also
records the model id as metadata, so the launcher rebuilds whenever the
provider or model differs from the last build (a stamp in `.output/`). The
stamp also covers every source the build reads (`lib/build.ts`
`buildInputsFor`):

- `agent/`, `lib/` and `store/`
- the adapter source and the package skills
- `packages/contracts/src/`
- the manifests and `pnpm-lock.yaml`

So a `git pull` that changes any of them rebuilds on the next start.

## Install

The runner is used from a **whole-repo clone**:

Node 24 is the tested version and ships with Corepack. On Node 25 or newer,
run `npm install -g corepack` first.

```sh
git clone https://github.com/radroid/workflow-catalog.git
cd workflow-catalog
corepack enable          # provides the pinned pnpm
pnpm install --frozen-lockfile
cd runner
npm run setup
npm run runner
```

Why not `npx degit radroid/workflow-catalog/runner` plus `npm install`: the
runner depends on `@workflow-catalog/contracts` and the eve adapter through
`workspace:*`, which only a pnpm workspace resolves. It would also produce a
second lockfile. A clone keeps one lockfile, installs exactly the tested
versions, and makes `git pull && pnpm install` the upgrade path.

## Scripts

Run them inside `runner/` as `npm run <script>`, or from anywhere in the repo
as `pnpm --filter @workflow-catalog/runner <script>`. In `runner/` with pnpm,
write `pnpm run setup`: a bare `pnpm setup` is pnpm's own command.

| Script | What it does |
|---|---|
| `setup` | Checks Node 24, chooses the workspace, connects the provider, writes `runner/.env.local`, prints a pairing code. Asks questions in a terminal; `--yes` never asks. |
| `setup -- --forget` | Lists, then removes, everything the runner stored (see Uninstall). `--dry-run` only lists; `--keep-workspace` keeps your data. |
| `doctor` | The install checklist. `--json` for machines, `--live` to verify the model with one short call. Exits 1 while a required item fails. |
| `runner` | Builds when needed, then starts eve and the bridge on loopback. Ctrl-C, SIGTERM or closing the terminal (SIGHUP) stops both, even during startup (`lib/launcher.ts`: route modules load and the bridge is built before eve is spawned, so a startup failure never leaves eve running). |
| `pair` | A new pairing code (10 minutes, single use). |
| `ui` | A new one-time sign-in link for the local UI. |
| `eval` | `eve eval --strict` on the fixture agent (no model, no credentials). |
| `test` | The unit tests (vitest), then the eval. |
| `typecheck`, `lint` | As everywhere in the repo. |

Flags go after `--`: `npm run setup -- --workspace ~/JobAssistant`. The boolean flags
`--json`, `--live`, `--forget`, `--dry-run` and `--keep-workspace` also work
without `--` (`npm run doctor --json`), because npm hands them over as
`npm_config_*`. Value flags must come after `--`, since npm has settings named
`workspace`, `provider` and so on.

### Setup

```sh
npm run setup                                    # interactive
npm run setup -- --workspace ~/JobAssistant --provider chatgpt --model gpt-5.6-luna --yes
npm run setup -- --provider openai --model <slug> --api-key-env MY_KEY_VAR --yes
```

- **Workspace.** The default is `~/JobAssistant`. Setup creates an empty
  folder, or reopens one that already has a valid `workspace.json`. It
  refuses a folder with other files in it, the disk root, your home folder
  itself, and anything inside this repository.
- **Provider.** One of `chatgpt`, `openai`, `anthropic` or `gateway`.
  - **ChatGPT:** Codex owns the sign-in (`codex login`) and the runner
    stores no ChatGPT credential. Setup runs `codex login status` and
    explains what to do if Codex is missing or signed out. The Codex sign-in
    is the only way in: under `eve start`, `chatgpt()` uses the credentials
    Codex keeps (`docs/spec/research/eve-spike.md`). eve's own `/login`
    lives in `eve dev`, which never runs in `runner/` (condition 4 above).
  - **API keys:** stored in the OS keychain (macOS Keychain, or Secret
    Service on Linux) under the service `workflow-catalog-runner`, never
    in a file. Under `eve start`, eve reads a provider key only from its
    environment (`eve/dist/src/internal/model-auth/api-key.js`), so
    `npm run runner` hands the key to the eve process in memory.
- **`runner/.env.local`** (mode 0600, gitignored; eve loads it too):
  - `EVE_TELEMETRY_DISABLED=1` and `EVE_TRACES_CONTENT=off`
  - `RUNNER_MODEL_PROVIDER` and `RUNNER_MODEL`
  - `RUNNER_CODEX_DIR`
  - `RUNNER_WORKSPACE`: once setup has written this one, it wins over the
    environment, unlike every other key in this list (see the note that follows)
  - `ROUTE_AUTH_BASIC_PASSWORD`: the per-install secret for eve's
    `httpBasic` route auth
  - `RUNNER_UI_TOKEN`: the local-UI cookie value

  A variable set in the environment wins over the file, as in eve — except
  `RUNNER_WORKSPACE`. GitHub Actions sets that one in every job, and a
  leftover shell export could set another, so once `npm run setup` has
  written a workspace to `.env.local`, the file always wins for that key:
  an ambient value can never redirect a set-up runner (P02.2). Before setup
  has written one, `runner`, `pair`, `ui`, `doctor` and `setup -- --forget`
  fall back to the environment, as for a first run or a test — the same
  runtime fallback every other key gets. Plain `setup` is the one exception
  to that fallback too (revision 1): it never takes the workspace from the
  environment, even on a first run — its own default is always
  `~/JobAssistant`, and `--yes` without `--workspace` always fails, asking
  for one explicitly. The environment is a runtime fallback for commands that read
  an existing install, never a choice setup makes for the person.
  `setup -- --forget` only ever offers to remove a workspace `.env.local`
  itself recorded; one only the environment names is left alone, noted, not
  offered.
- **Re-running** keeps the workspace, the stored key and both secrets. It
  updates only what you change.

### Doctor

It has seven items, all required:

- The catalog install page's five, with the same ids and labels:
  `node`, `runner`, `provider`, `workspace` and `extension`.
- `privacy`: the two eve switches.
- `eve`: the exact pin.

Each item is `ok`, `warn` or `fail`. A `warn` is not a failure: a provider
that is connected but not yet verified is a warn until `doctor -- --live`,
or "Check the model" on the status page, gets an answer. `workspace` is a
warn when the environment's `RUNNER_WORKSPACE` really names a different
folder from `.env.local`'s — compared by real folder, not by string, so a
trailing slash, a symlink or `..` segments naming the same folder never
warn (P02.2 revision 1). The detail names both paths and says which one the
runner uses; the fix line reads `npm run setup -- --workspace <path>`. The
JSON form is
`{ ok, checkedAt, items: [{ id, label, status, detail, required, fix? }] }`.

## The bridge (`server/`)

Hono on `127.0.0.1:4310`, loopback only. The extension talks only to the
bridge. The bridge talks to eve server-side with `eve/client`, using Basic
auth. The extension-facing routes are exactly these four (mvp-spec §5):

| Route | Body / answer |
|---|---|
| `POST /pair` | `PairRequest` → `PairResponse` `{ deviceId, token }` |
| `GET /commands?since=` | `CommandsResponse`: the device's pending `open_application_group` commands, leased for 5 minutes |
| `POST /events` | `EventsRequest` (`job_capture`, `browser_command_result`, `application_status_changed`) |
| `GET /status` | `StatusResponse` `{ version, workspaceId, budget, schedules }` (no personal data) |

Each request passes these checks in order, and the first failure answers:

1. **Host.** It must be exactly `127.0.0.1:4310` or `localhost:4310`,
   else **403** `host_not_allowed`. This is the defence against DNS
   rebinding.
2. **Route.** An unknown route or method gets **404**.
3. **Declared size.** A `Content-Length` over 256 KiB
   (`MAX_BRIDGE_BODY_BYTES`) gets **413**, before a byte is read.
4. **Token.** It must be `Authorization: Bearer <device token>`, else
   **401** with `WWW-Authenticate: Bearer`. The bridge stores token hashes
   only. Tokens last 30 days.
5. **Origin.** Chrome sends no `Origin` on an extension's GET (from its
   pages, its service worker and alarm-driven fetches alike; measured on
   Chromium 153), and sends `Origin: chrome-extension://<id>` on its POST.
   So:
   - A GET (or HEAD) with no `Origin` is accepted on the device token alone.
   - An `Origin` that is present must equal the origin the device paired
     from, else **403** `origin_not_allowed`.
   - A POST must carry that origin, else **403** (`origin_required` when it
     is missing).
6. **Content type.** It must be `application/json`, else **415**.
7. **Streamed size.** More than 256 KiB of body gets **413**, counted as it
   streams, whatever the declared length said.
8. **Contract.** The JSON is validated with the `@workflow-catalog/contracts`
   schema. A failure gets **400** `invalid_body`, with every zod issue and its
   `path`.

Identity comes from the token: events carry no `deviceId`, by design.

- **Pairing.** `setup`, `pair` and the status page issue a code like
  `7KQ2M-X9RTB`. It is 10 characters of Crockford base32 (about 50 bits),
  lasts 10 minutes and works once. Only its hash is stored. `/pair` accepts
  only a `chrome-extension://<32 letters a-p>` origin, which becomes the
  device's origin. Wrong codes are limited two ways:
  - **Per origin, for fairness.** After 10 wrong codes in 10 minutes from
    one origin, `/pair` answers that origin 429, so another extension's
    wrong codes never lock this one out.
  - **Per code, for security.** A local process can send any extension
    origin, so the per-origin limit alone does not bound guessing. Once 100
    wrong codes, from any origins, have been tried since a code was issued,
    that code is withdrawn: even the right code then gets 401.
    `npm run pair` issues a new code, with a fresh budget.

  Revoking a device (status page, or `POST /api/devices/<id>/revoke`)
  deletes it, and its token fails on the next request.
- **Replay.** Every event is journaled once per `eventId`
  (`.runner/events/`), using an exclusive create. A replay gets the stored
  outcome back with `duplicate: true`, and its handler does not run again.
  The same `eventId` with a different body, or from another device, is
  **409** `event_id_conflict`. Only a handler that failed unexpectedly runs
  again, when the extension retries.
- **Event status codes.** With no handler for its type, an event is
  journaled and acknowledged with **202**. A handled event gets **200**,
  with the handler's `result`. A handler's rejection gets its own 4xx.
- **CORS.** CORS is not authentication. Preflights and responses carry
  `Access-Control-Allow-Origin` only for the paired extension origin; for
  `/pair`, for any well-formed extension origin.

## The local UI (`ui/`, `server/local-ui.ts`)

Plain HTML pages with small scripts and no framework, at
`http://127.0.0.1:4310/ui/<page>`. `/` redirects to `/ui/status`. Any web
page the person visits can send requests to 127.0.0.1, so the UI and its
JSON API are protected as follows:

- **Host check.** The same check as above, so DNS rebinding fails.
- **Sign-in.** `npm run runner` prints a one-time link,
  `/ui/login?nonce=…`, and `npm run ui` prints a fresh one. A link lasts 10
  minutes and works once. A HEAD request does not use it up. It sets the
  cookie `wc_runner_ui` (HttpOnly, SameSite=Strict, Path=/, 30 days). Every
  page and every `/api/*` route needs that cookie.
- **Same-origin API.** When the browser sends `Sec-Fetch-Site`, `/api/*`
  answers only `same-origin`, which is what the runner's own pages send.
  - `cross-site` and `same-site` are refused. Cookies are not scoped by
    port, so a page on another port of 127.0.0.1 is "same-site" and would
    otherwise carry the cookie.
  - `none` is refused too. Chrome sends the SameSite=Strict cookie with a
    fetch from any extension that has host permission for the bridge, and
    marks it `none` (measured on Chromium 153).
  - Pages and the sign-in link are navigations, so they keep working with
    `none` (a link opened from the terminal, or a typed address).
- **State changes.** Any request other than GET and HEAD also needs an
  `Origin` equal to the bridge's own origin and a JSON `Content-Type`,
  which an HTML form cannot send.
- **Headers.**
  - Every response: `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  - Pages also get a CSP that allows only the bridge's own scripts, styles
    and fonts, with `frame-ancestors 'none'`.

The **status page** (`ui/status.html`) shows:

- the doctor checklist
- the model, with "Check the model"
- the paired browsers, with Revoke and "New pairing code"
- the workspace

Revocation (mvp-spec §7.5) lives here until a pairing section joins
Settings. Fonts are Geist, self-hosted (`ui/assets/fonts`, SIL OFL).

The **Jobs page** (`ui/jobs.html`, P04) captures a job posting three ways:
the extension's own capture action (the `job_capture` bridge event), pasting
the posting's text and address, or fetching an `https://` link
(`lib/safe-fetch.ts`, every SSRF check — a pasted or captured URL may be
`http://` or `https://` as provenance only, since nothing on those two paths
fetches it, but the fetch path itself refuses anything but `https://`). Each
path normalizes the posting text once, with the one shared rule
(`normalizePostingText` in `lib/readable-text.ts`: CRLF folded, runs of
spaces and tabs collapsed, each line trimmed, then the whole), and refuses
text that is empty afterwards. Each stored address drops its userinfo and
fragment and is written in the WHATWG URL serialization (lower-case host,
default port dropped), the same on every path, which also helps two
captures of one page dedupe. All three converge on one handler
(`captureAndExtract` in `server/routes/captures.ts`), so the same posting
produces the same snapshot text and content hash regardless of source (F6),
whitespace differences included. A job that already has this exact URL and
unchanged text (by content hash) gets no new revision; changed text creates
the next revision and keeps every one before it, forever.

A content-changing capture answers as soon as its snapshot is saved, and
queues extraction, never for an unchanged capture. The queue runs one turn
at a time per workspace, through `runTurn`, and never queues a revision
that is already waiting or running. Just before each turn it checks again
that a turn can start (eve running, a model set, the budget not paused), so
a turn that hits a provider limit and pauses the budget stops the rest of
the queue, each recorded as not run. The posting's text is delivered to the
model only as user-turn data inside a random per-call boundary, never a
system prompt, and the model reports back only IDs and the fields it
drafted (`extract_job`, which checks and returns them but never writes).
The route saves the fields only after the turn ended ok, and only for the
revision it was extracting, so a failed Re-extract keeps the fields already
saved, and a running one shows them until it finishes. Each revision's
extraction state sits beside its snapshot, in
`jobs/<jobId>/extraction-<rev>.json`; a waiting or running state left by an
earlier runner process reads as interrupted, and Re-extract queues it
again. A snapshot or state file that can't be read, or a job's whole directory
(no read permission, say), is never a server error or a silent gap: the job
still lists, by the address any readable revision records, with the damaged
file's — or the folder's — path named. Opening a job lists every revision, newest first,
each with a line-based diff against the one before it ("What changed from
the previous revision", collapsed to a few lines of context around each
change — no dependency, since a posting is plain text and this is a diff to
look at, not a merge tool) and, for the latest revision, the structured
fields found so far (title, company, location, requirements, nice-to-have,
deadline, apply link) with a button to run extraction again for a revision
saved before eve was running, whose turn did not finish, or that a person
just wants re-checked. While it is visible, the page refreshes itself, every
2 s while an extraction is waiting or running and every 5 s otherwise, and
updates the list and the open job in place: open sections stay open and a
focused control never moves. It announces the result of an extraction only
if the page started it; a capture from the extension joins the list without
an announcement. As with the Runs and Settings pages below, one
persistent live region announces every outcome once, in one short sentence
with the consequence first (the reasons live in the job's detail), `aria-disabled` marks a
request in flight without dropping focus, and — since `server/http.ts`'s own
validation messages name the offending field for API consumers, not a person
reading the page — every message this page shows is its own hand-written
sentence: no field name, HTTP status code or id ever appears in its visible
text.

The **Applications page** (`ui/application.html`, P05;
`server/routes/applications.ts`) prepares a saved job's resume, and a cover
letter when asked, from the career profile's confirmed claims only.
Preparing is locked until the profile is approved ("Preparation is locked:
… The workflow will not guess.") and until the person has typed the name
their documents carry (`applications/details.json`, never sent to the
model). One turn runs at a time per workspace, through `runTurn` inside
`withRun`. The prompt carries the posting's fields and the confirmed claims,
each by a position label (`[C1]`, never its id), as user-turn data inside a
random per-call boundary; excluded and unconfirmed claims never reach it,
and nothing from a posting ever reaches `instructions.md`, a skill or the
system prompt. The model hands back one thing through `prepare_application`:
a task id, its account of every requirement (covered by which labels, a gap
question, left out, or not a requirement) and the draft, with a `[C#]`
citation on every sentence. That tool only checks and returns. The
deterministic validator (`validate/`, no model) refuses a sentence with no
citation, a citation of anything but a confirmed claim, an id, a number,
date, job title or credential its cited claims don't state, a heading the
runner doesn't use, or the posting's own wording, and the model revises.
After the turn the route re-reads the profile, validates the draft again
(whatever the tool's answer said), and only then exports (`export/`):
Markdown, DOCX (`docx`, its author the person's name) and PDF (`pdfkit`,
set in Noto Sans embedded from `@expo-google-fonts/noto-sans`: Latin with
its extensions, Greek, Cyrillic and Vietnamese print as typed; anything the
font can't draw prints as � and the page says so under the field it was
typed in (name or contact line), in the save's line, and beside that PDF,
whose link points to the note, and that the Markdown and Word files keep
it), with the
citation markers stripped at this step and no earlier, plus
`diff-v<n>.md`, which puts every sentence beside the claims it cites and
names the presentation change. The model is told only that a label or
wording isn't among the confirmed claims it was given; which of them was
excluded is the person's to see, never the model's. A gap question parks
the preparation: eve withdraws a run's pending `ctx.ask` requests when the
run ends, so the runner keeps the questions (`preparation.json`). The run
ends, the page shows the questions in amber while any is open, the row
says how many are left (then "Ready to continue", or "Waiting for the
evidence you're adding"), and once each is answered (leave it out, or add
evidence on the Onboarding page) preparing again continues from the
answers. A turn that is not ok, a draft still refused, a tool call other
than the preparation tools, or a profile that changed during the turn saves
nothing and says why in plain words; a failed or parked preparation never
moves the job's stage. While an application record that may be the job's
can't be read, Prepare refuses and names the file, rather than start a
second application. Each version records its profile version, job revision
and idempotency key (the job, its revision, the profile version, whether a
cover letter was asked for, a digest of everything the model read, and a
digest of the name and contact line the documents carry), so preparing
again with the same inputs writes nothing (when the newest documents carry
that key; switching a name back re-exports), and a changed profile gives a
new version that names the one it replaces. A changed name or contact line
alone re-exports the validated draft under it, checked again first, as a
new version naming the one it replaces, with no model turn and no run; its
cover letter keeps the date it was first written, and its note says whose
sentences it carries and what changed since the version it replaces. If
today's checks refuse that draft, the re-export is refused once, saying the
documents must be prepared fresh, and the next Prepare runs a fresh
preparation instead of refusing again.
Documents are dated in the runner machine's time zone, the person's, so a
letter and the page say the same day. With nothing pending, Prepare again
keeps the newest version's choice of a cover letter; an attempt still
pending keeps its own, whether it continues a parked attempt or retries a
failed or interrupted one. At
today's run limit, Prepare refuses at once and names the limit. At start, a version
whose files and record were all written before the runner stopped is
attached, and any other preparation left running is marked interrupted.
Documents download as attachments with a sandboxing CSP, under a
descriptive name ("Ada Quill - Resume - Fernwood Platform Lead.pdf", with
RFC 6266's `filename*` when it isn't ASCII), and only files the
application's record lists; the workspace keeps its own file names. The
page follows the Jobs page's rules: one live region, each outcome announced
once, including a preparation that was already running when the page
loaded, and outcomes that settle in one refresh share one line; a refresh (every 2 s while a preparation runs, 5 s otherwise, only
while visible) that keeps focus and open sections, and that says once,
while a watched preparation can't be refreshed, "Can't reach the runner. Is
it still running?"; a busy button `aria-disabled`; no field name, status
code or id in visible text. Claim labels appear only in "What changed and
why", which shows citations on purpose.

The **Runs page** (`ui/runs.html`, P08-A) lists every run this instance has
made (`GET /api/runs`), newest first, bounded to 200 records / 14 days. Each
entry shows the date and time, the kind as a readable label, an outcome pill
with its reason in plain language right beside it (an internal error code
such as `MODEL_CALL_FAILED:` appears only in the "View JSON" disclosure, never
the visible text), the duration, tokens in/out, the model, a catch-up badge,
the item-cap note when a run stopped early ("stopped at the per-run cap (N);
M jobs stay Saved"), a shortened form of the record's file path
(`runs/<date>/<8 chars>….json`, the full relative path in the tooltip) with a
"Copy path" button for the absolute path, and the "View JSON" disclosure.
Each "Copy path" button is named for its run's kind and time, and shows
"Copied" or "Couldn't copy" right beside it for a few seconds (hidden from
screen readers; the live region makes the one announcement). "View JSON"
shows the record exactly as it is on disk, with its workspace path and
absolute path listed apart above it. A record whose model is `n/a` never
called the model (paused, or a body that failed before any turn) and shows
no duration/tokens/model line; `unknown` means a turn was sent but eve never
said which model (a timeout before the first step), so the duration and
tokens show and only the model is hidden. A record with no `finishedAt` at
all (the runner stopped mid-run) shows a neutral "Did not finish (or still
running)" pill instead of an outcome. Catch-up marks and past paused records
use a neutral badge, not amber — amber is reserved for the *current* pause on
the Settings page. A file that exists but fails to validate is skipped and
named rather than crashing the list: up to 10 short paths in `<code>`, one
per line (full path in the tooltip), then "and N more.". A whole date folder
that fails to list (a permissions problem, say) is one entry, `runs/<date>/`
(or `runs/` for the whole log), and the count then reads "run records or
folders" — skipped with a note, never a 500. Empty state: "No runs yet.",
shown once, never echoed into the live region.

The **Settings page** (`ui/settings.html`) holds one `<section>` per concern,
each with its own script, so later packets can add a section without
touching another's. Today it has:

- **Budget** (`ui/assets/settings-budget.js`, P08-A): the daily run limit
  (1–50, default 10) and the per-run item cap (1–20, default 5) as bounded
  number inputs with their range stated as hint text, runs used today, the
  pause with its reason and a Resume button, and Save. An out-of-range or
  non-numeric submission is caught client-side before any request: the field
  gets `aria-invalid`, keeps focus, and the live region gets one plain
  sentence — the server's raw 400 body is never shown. Backed by
  `GET`/`POST /api/runs/budget` and `POST /api/runs/budget/resume`; every
  message is built from the state the server just returned, never from what
  the page saw earlier. A corrupt `runs/budget.json` is reported paused with
  the reason "budget settings unreadable (runs/budget.json)" rather than
  crashing, its path in `<code>`, and a note that the limits shown are the
  defaults. Resume rewrites it with the default limits and unpauses ("Runs
  resumed with the default limits: 10 runs a day, 5 jobs per run.", because
  the resume response says `restoredDefaults`). Save rewrites it with the
  submitted limits but keeps it paused until Resume, since decision 2 does
  not let an unrelated Save silently clear a pause: the stored reason becomes
  "budget settings were unreadable (runs/budget.json)", the note says the
  limits are saved and Resume restarts runs, and Save announces "Budget
  saved. Runs stay paused until you press Resume."; a later Resume keeps the
  saved limits and says "Runs resumed.". When today's run folder
  (`runs/<date>/`) can't be listed, the runs used today are unknown, so the
  budget reads as paused with the fixed reason "run log unreadable
  (runs/<date>/)" (derived on every read, never stored; `withRun` refuses
  runs with paused records wherever one can be written). Settings shows
  "unknown" usage and no Resume, since Resume can't make the folder
  readable; the pause clears by itself once it is. `pauseKind` says which
  pause is showing, first match wins: an unreadable budget file, a repaired
  one, a stored pause, an unreadable run log. `GET /status` stays 200 even if
  the budget can't be computed at all (then it reports paused, "budget status
  unavailable"). **`paused` only ever means a pause that needs attention —
  the stored manual/provider-limit pause or one of those unreadable-file
  pauses — and is never set just because the daily limit was reached.** A
  consumer that wants to know "is today's quota used up" compares
  `runsUsedToday >= dailyRunLimit` itself (both fields are in the contract);
  Settings shows this state as "Daily limit reached. New runs wait until
  tomorrow.", below Save so it never moves Save from under the pointer. All
  budget-file writes (`pauseBudget`, `resumeBudget`, `setBudgetLimits`, and
  `withRun`'s own paused/limit check + `startRun`) go through one in-process
  serialization (`store/budget.ts`'s `withBudgetLock`), so a Save racing a
  provider-limit pause can never lose either one.

- **Schedules** (`ui/assets/settings-schedules.js`, P08-B): one card per
  schedule (daily-prepare, weekly-review), each showing its cron and time
  zone in plain words ("Daily at 09:00 UTC"), its next run, its last
  successful run (or "No successful run yet"), daily-prepare's own per-run
  item cap, and a Pause/Resume button. A schedule's own pause is independent
  of the budget's above — pausing daily-prepare here never touches Budget,
  and a provider-limit pause on Budget stops every schedule regardless of
  its own pause state. Backed by `GET /api/runs/schedules` and
  `POST /api/runs/schedules/:id/pause`/`/resume`; every card re-renders from
  the state the server just returned, the same rule Budget follows. Pressing
  Pause or Resume moves focus to the section heading first (`tabindex="-1"`),
  the same as Budget's Resume, since the button pressed gets replaced when
  the list re-renders.

Both pages share one persistent live region (`role="status"
aria-live="polite"`) per page for every success and error, with section-
specific wording ("Budget saved.", "Runs resumed.") that is re-announced even
when repeated; its space is reserved while empty, so a message appearing
never moves anything under the pointer. Both use `aria-disabled` rather than
the `disabled` attribute on a busy button so focus is never dropped
mid-action.

`withRun` (`server/run-harness.ts`) never rejects before the run's body: an
empty idempotency key, or a run record that can't be written, resolves with
an in-memory failure record (logged, never written). `runTurn` reads eve's
response stream event by event rather than trusting a single aggregated
result, because eve@0.63.0 can end an aborted turn quietly with no thrown
error (`docs/spec/research/eve-runtime.md` §8 item 15). A turn is ok when it
ends at a `session.waiting` boundary (every conversation turn:
`turn.completed → session.waiting`) or `session.completed` (task mode) with
no failure event, no `turn.cancelled` and no abort. Only a non-empty
`input.requested` list means the model is waiting on the person; that turn
is cancelled and the run fails. `turn.cancelled`, a failure event or
`session.failed` is not ok. Every cancel goes through the session, bounded
to 5 s, not the turn response, which eve does not reliably act on before a
turn has started or once it is parked. `classifyTurn` also parks on a
pending `authorization.required` with no `webhookUrl` — eve keeps a turn
response open past `session.waiting` only while one *with* a `webhookUrl` is
pending (`docs/spec/research/eve-runtime.md` §8 item 15); one with none ends
the response quietly and would otherwise read as ok.

**Schedules and catch-up** (`scheduler/`, P08-B): two fixed schedules, daily
`prepare_newly_saved_jobs` (09:00 UTC) and weekly `review_open_applications`
(Monday, 09:00 UTC). What actually fires a schedule is **the bridge's own
clock**, not eve's cron: eve documents no catch-up for a missed fire and no
signal that a fire happened at all (`docs/spec/research/eve-runtime.md` §4;
the P02 spike's own risk note), and `withRun`/`runTurn`/the budget and run
stores all live in the bridge process, not inside eve's. `routes/runs.ts`'s
`start()` hook (`scheduler/index.ts`'s `startScheduler`) runs a due-schedule
check once immediately (catch-up) and then every five minutes (the fallback
trigger) — the same function either way, so there is exactly one trigger
mechanism, never two that could race. Each check resolves the schedule's
current slot (the local calendar day, or Monday-anchored week, in its own
fixed time zone; `scheduler/time.ts`, pure and `Intl`-based, no new
dependency) and atomically claims it (`scheduler/store.ts`'s `claimSlot`, a
`Workspace#createJson` exclusive create) before doing any work, so the
fallback trigger and a startup catch-up can never both fire the same
overdue slot — and a runner that missed several fires in a row still claims
and runs only the single latest one. A fire more than five minutes late is
`isCatchUp`. Daily-prepare calls P05's own `startPreparation` once per
Saved-stage application (oldest first, up to the budget's `itemCap`; the
rest stay Saved for next time) — no second preparation path, and no second
turn classifier, since that function already runs its turn through
`withRun`/`runTurn` itself. Weekly-review has no existing pipeline to
delegate to, so it calls `withRun`/`runTurn` directly, with its own
idempotency key per slot (checked through `hasSucceededWithIdempotencyKey`
before running; a rejection there — an unreadable date folder — means
"unknown", never "not done", so the run does not start rather than risk a
duplicate). A schedule has its own pause, independent of the budget's; both
persist to disk and so survive a restart. A parked preparation (open gap
questions) is not a failure for the schedule: no retry, no failure count, no
backoff — it is simply left for the person to answer on the Applications
page, and P05's own dedup refuses a second attempt at it on its own.

## Workspace layout

The spec §5 layout, plus `.runner/` for the bridge's own state:

```text
workspace.json    { workspaceId, workflowInstanceId, packageVersion, createdAt }   (WorkspaceManifest)
sources/ jobs/ applications/ sessions/ outbox/ inbox/
jobs/<jobId>/snapshot-<rev>.json         one job posting's revision (P04): url, capturedAt, extractorVersion,
                                         contentHash, text, structured — revision 1 is never overwritten by a
                                         later one; the same URL with the same content hash gets no new revision
jobs/<jobId>/extraction-<rev>.json       that revision's extraction state (P04): waiting, running, done, not run
                                         or failed, with a reason code; waiting/running name the runner process
applications/<taskId>.json               one application (P05): the contract's Application record, one per job
applications/<taskId>/preparation.json   its latest preparation attempt (P05): running, parked on gap questions
                                         with the answers so far, failed (and why), or done
applications/<taskId>/versions/v<n>.json one prepared version (P05): the validated draft, the claims it cites,
                                         the per-sentence diff and the changes since the version it replaces,
                                         the name and contact line its documents carry, and what its PDFs
                                         couldn't draw
applications/<taskId>/docs/              resume-v<n> and cover-v<n> (.md, .docx, .pdf), diff-v<n>.md (P05)
applications/details.json                the name and contact line on every document (P05); never sent to the model
runs/<date>/<runId>.json                one run record (P08-A); <date> is startedAt's OS-local calendar day
runs/budget.json                        daily run limit, per-run item cap, and the pause (P08-A); survives restart
scheduler/state.json                    each schedule's own pause, last attempt, last successful run (P08-B)
scheduler/claims/<id>--<slot>.json      one-shot marker: this schedule already fired for this slot (P08-B)
.runner/devices/<deviceId>.json         paired devices (token hash, origin, expiry)
.runner/pairing/<sha256>.json           outstanding pairing codes
.runner/ui-login/<sha256>.json          outstanding UI sign-in links
.runner/events/<eventId>.json           the event journal (holds captured job text: personal)
.runner/commands/<commandId>.json       the command queue for GET /commands
.runner/model-check.json                the last live model check (no prompt or reply text)
```

Every write is atomic: the store writes a temp file in the same folder,
fsyncs it, renames it over the target, then fsyncs the folder. Every path
goes through `Workspace.resolve`, which refuses `..`, absolute paths, NUL
bytes and symlinks that lead out of the workspace.

## Extending the runner

Later packets add behaviour by **adding files**. They never edit the files
P02 wrote. Four conventions:

**1. Route modules: `server/routes/<name>.ts`.** The bridge loads every
file in `server/routes/` at start, in name order, and skips `_helpers.ts`
and `*.test.ts`. Each file default-exports:

```ts
import { defineRouteModule, EventRejectedError } from "../route-modules.ts";

export default defineRouteModule({
  // Local-UI JSON routes, mounted at /api/<name>, already behind the
  // local-UI guard (Host, cookie, same-origin). Read bodies with
  // readBoundedJson from ../http.ts and a cap that suits the route.
  api(router, ctx) {
    router.get("/", async (c) => c.json({ ok: true }));
  },
  // POST /events handlers, one module per type (two claiming one type is
  // a startup error). The event is already authenticated, contract-valid
  // and journaled; the return value is stored and sent back as `result`.
  events: {
    job_capture: async (event, ctx) => {
      // ctx.device is the paired device; ctx.workspace, ctx.journal, ctx.commands...
      // Throw new EventRejectedError(409, "stale_revision", "...") to refuse with a 4xx.
      return { jobId: "..." };
    },
  },
  // Budget and schedules for GET /status.
  status: async (ctx) => ({ budget: { dailyRunLimit: 20, runsUsedToday: 0, paused: false }, schedules: [] }),
  // Runs once when the bridge starts (after eve is ready); may return a stop function.
  start: async (ctx) => () => {},
});
```

`ctx` (`server/context.ts`) holds:

- `workspace`, `clock`, `log`
- the stores: `devices`, `pairing`, `uiLogin`, `journal`, `commands`
- `eve`: the `eve/client` gateway; undefined in tests
- `model`, `packageVersion`

Log operational lines only, never content.

**2. Stores: `store/<domain>.ts`.** Write one module per domain, on top of
`Workspace` (`readJson`, `writeJson`, `createJson`, `list`, `resolve`) and
the atomic helpers. Validate with the contracts when reading and writing.

**3. Pages: `ui/<page>.html`.** Shared styles and helpers are in
`ui/assets/runner.css` and `ui/assets/runner.js` (`getJson`, `postJson`,
`el`). Put `<!-- runner:nav -->` where the navigation goes. The planned
pages (onboarding, profile, jobs, board, sessions, runs, settings, status)
join the nav on their own. Any other page joins it with
`<meta name="runner-nav" content="Label">`. Scripts must be files under
`ui/assets/`, because the CSP allows no inline script.

**4. Model tools: `agent/tools/<name>.ts`.** Write each as a `defineTool`,
thin, with typed input. Pass IDs, never raw content or URLs.
`defaultTools: false` stays: add only the tools you need. Every prompt
change ships with a fixture that proves it (`eval-agent/`).

| Packet | Adds |
|---|---|
| P03 | `server/routes/onboarding.ts`, `store/profile.ts`, `ui/onboarding.html`, `ui/profile.html`, `agent/tools/extract_claims.ts`, `agent/tools/ask_follow_up.ts`, onboarding skills |
| P04 | `server/routes/captures.ts` (the `job_capture` handler, plus the paste/url-fetch/list/detail/re-extract routes), `store/jobs.ts`, `lib/safe-fetch.ts`, `lib/readable-text.ts`, `agent/tools/extract_job.ts` (IDs only: jobId, revision, structured fields — never a URL or raw text; it checks and returns the fields, and the route saves them after an ok turn), `ui/jobs.html` |
| P05 | `server/routes/applications.ts` (list, detail, prepare, answer a gap question, the documents' header, downloads; queues the preparation turn through `runTurn` inside `withRun`), `store/applications.ts`, `agent/tools/prepare_application.ts` with `agent/lib/prepare-*.ts` (IDs, requirement accounts and the cited draft only — never a claim's id or text; it checks and returns, and the route saves after an ok turn and a second check), `validate/` (the deterministic validator), `export/` (Markdown, DOCX, PDF with its embedded Noto Sans, the diff, the download names), `ui/application.html`, the five preparation skills and the resume and cover-letter templates |
| P06 | `server/routes/{applications,sessions,commands}.ts` (the `application_status_changed` and `browser_command_result` handlers), `store/sessions.ts`, `ui/board.html`, `ui/sessions.html`, and the body of `agent/tools/open_application_group.ts`. The tool queues commands through the workspace files (see "Commands" below); the `browser_command_result` handler retires them with `ctx.commands.acknowledge()`. |
| P07-B | Nothing here. The extension uses the four bridge routes. |
| P08-A | `store/runs.ts` (the run log), `store/budget.ts`, `server/run-harness.ts` (`withRun`, `runTurn`, and the `classifyTurn` P03.2 split out of `runTurn` — free functions over `ctx`, now called from `routes/onboarding.ts`'s extraction route and `eve-gateway.ts`'s `checkModel`), `server/routes/runs.ts` (list/get runs, budget `GET`/`POST`/`resume`, `status()` for `budget`), `ui/runs.html`, the budget section of `ui/settings.html`. |
| P08-B | `scheduler/` (`config.ts` the two fixed schedules and `SCHEDULES_PROMPT_DIR`, `time.ts` pure cadence math, `store.ts` per-schedule pause/attempt state and the slot-claim, `dispatch.ts` the daily-prepare/weekly-review bodies and the catch-up/fallback dispatcher, `status.ts` the `GET /status` and Settings shapes, `index.ts` the `start()` wiring, `prompts/` — the schedules' prompt files, `daily-prepare.md` documents the schedule and `weekly-review.md` is its turn's own prompt; they live here, not under `runner/agent/schedules/`, because in mode A the runner's own scheduler owns firing, and eve would otherwise discover and compile them as its own cron schedules — a second, uncontrolled trigger the design rules out), the schedules section of `ui/settings.html` + `ui/assets/settings-schedules.js`, and `server/routes/runs.ts`'s `status()` for `schedules`, `start()` (catch-up), and `GET`/`POST /api/runs/schedules[...]`. Calls into `run-harness.ts`'s `withRun`/`runTurn` and `routes/applications.ts`'s `startPreparation` to actually run something; never edits either. |
| P10 | `upgrade/`, the upgrade section of `ui/settings.html`, and an optional `server/routes/upgrade.ts`. |

**Commands.** `GET /commands` is already complete over
`store/commands.ts`. P06 only has to fill the queue and acknowledge
commands.

- It is device-scoped, and never delivers an expired command.
- A delivery leases the command for 5 minutes. A command still
  unacknowledged when its lease lapses is delivered again, whatever `since`
  says, so a service worker that dies holding a command cannot strand it.
- `since` only narrows commands never delivered: they must be created at or
  after it. Omitting `since` is always safe, because the lease already keeps
  one command from being handed out twice at once.
- `HEAD /commands` is checked like a GET but leases nothing.

`open_application_group` runs inside eve's process (`eve start`), not the
bridge's, so there is no `ctx` and no `ctx.commands` there. The tool
enqueues through the workspace files, with the same store:
`new CommandQueue(await Workspace.open(process.env.RUNNER_WORKSPACE), systemClock).enqueue(command)`.
eve's process has `RUNNER_WORKSPACE`, because the launcher passes the
settings in its environment. This is safe across processes:

- An enqueue only creates a new file, exclusively (`link(2)`), which appears
  whole.
- Only the bridge leases and acknowledges, serialised in its one process.

## Privacy

- **Runner output is personal data.**
  - The runner writes no log files. eve's output is prefixed `[eve]` and
    goes to the terminal only.
  - A failed model call prints its whole request to that output (spike), so
    do not paste it anywhere public.
  - The bridge logs operational lines only, never content.
- **`.eve/` is personal data.** eve keeps session state in
  `.eve/.workflow-data`, and the message content in it is unencrypted
  (spike). It is gitignored, never shared, and removed by uninstall.
- **eve's privacy switches.** Setup turns off eve's CLI telemetry
  (`EVE_TELEMETRY_DISABLED=1`) and trace content (`EVE_TRACES_CONTENT=off`),
  and `doctor` checks both.
- **Provider keys** are kept only in the OS keychain.
- **The workspace** is a folder the person owns: plain JSON files they can
  read and delete.

## Uninstall

`npm run setup -- --forget` lists what the runner stored, then removes it
after a confirmation (or with `--yes`):

- `runner/.env.local`
- `runner/.eve/`, `runner/.output/`, `runner/.nitro/`
- `runner/eval-agent/.eve/` and `.output/`
- the workspace folder, but only when its `workspace.json` is valid
  (`--keep-workspace` keeps it)
- the runner's keychain entries

It also lists **eve's own sign-in**, which is shared by every eve project on
the computer, and asks separately before removing it (default no). `--yes`
never removes it; only an answer in a terminal does:

- the keychain entries under service `eve`: `chatgpt`, `openai-key`,
  `anthropic-key`, `ai-gateway-key`, `vercel`
- `~/.eve/connection.json` and `~/.eve/auth/chatgpt.json`

The Codex CLI's ChatGPT sign-in belongs to Codex; remove it with
`codex logout`. After `--forget`, deleting the repository folder leaves
nothing behind.

## Tests and the eval

- `npm test` runs the vitest suites in `test/`, then `npm run eval`.
  - The vitest suites cover the stores, the bridge, pairing, the local UI,
    route modules, setup, doctor, uninstall and the keychain encoding.
  - It needs no codex, no model call and no credentials, so it runs in CI.
- `npm run eval` builds the adapter, then runs `eve eval --strict` on
  `eval-agent/`: a separate eve app root with `mockModel` and the real
  adapter, tools and sandbox. Its evals prove four things:
  - The tool surface is exactly `load_skill` plus `open_application_group`,
    with no shell, file or web tools.
  - The data rule is in the system prompt.
  - A `jobs__*` skill loads.
  - `open_application_group` parks with an approval request instead of
    executing, and calls to tools that do not exist fail without running
    anything.
- `eve eval` always starts its own development server on 127.0.0.1 with an
  ephemeral port (`eve/dist/src/evals/cli/eval.js`). The port cannot be set,
  and the server stops with the eval.

## Files

```text
agent/            the eve agent: agent.ts, instructions.md, channels/eve.ts (httpBasic, then localDev),
                  extensions/jobs.ts (the adapter), sandbox/sandbox.ts (refuses to create one),
                  tools/ (load_skill, open_application_group), lib/ (model and agent options)
eval-agent/       the eval fixture: its own eve app root on mockModel, with evals/
server/           the bridge: app.ts, extension-api.ts, events.ts, local-ui.ts, route-modules.ts,
                  context.ts, eve-gateway.ts, http.ts, routes/ (status, devices, pairing, model)
store/            the workspace and the runner's own stores
lib/              settings, the .env.local file, secrets, codex, doctor, setup, uninstall, builds, the launcher
cli/              the npm scripts
ui/               the local UI pages and assets
test/             vitest suites and fixtures
```
