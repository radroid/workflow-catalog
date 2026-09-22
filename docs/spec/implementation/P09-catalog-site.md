# P09 · Catalog site on Vercel Hobby

Status: claimed (part B)
Assignee: iter-002 implementer (Sonnet), part A; iter-003 implementer (Sonnet), part B
Blocked by: P00, P01
Owns: apps/catalog/, .github/workflows/release-package.yml
Spec: F1, F2, F3, §6 catalog screens, §7 rule 1, runtime-budget.md §1–2

## Goal
An invite-only, themed catalog that explains the workflow, distributes the package, guides the install, and hosts the learning docs, at $0 on Hobby, storing nothing personal.

## Deliverables
- Invite sign-in: owner admin page gated by `OWNER_SECRET`; create invite links (token, single use, five max); friend opens link → display name → session cookie (signed, httpOnly). Neon free Postgres via the Vercel Marketplace with a three-table schema (invites, sessions, install_status). No email provider.
- Template page rendered from `packages/job-assistant/workflow.json`: purpose, required sources, connections, browser permissions, version, checksum, changelog, download link to the GitHub Release asset. A release workflow that packs `packages/job-assistant` into a tarball on tag `job-assistant@x.y.z`.
- Install guide: the exact commands (`git clone` or `npx degit` of `runner/`, `npm install`, `npm run setup`, extension install from the private Web Store listing or unpacked for now), a live checklist the person ticks (mirrors `npm run doctor`), and the privacy statement: what stays local, what goes to the chosen provider, telemetry off.
- Learn: `docs/learn` rendered (lessons and references as static HTML with the course stylesheet).
- Theme: tokens from `docs/spec/visuals/theme.css`, Geist via `next/font`, light and dark; no component library needed.
- `vercel.json`: no cron; functions default; Deployment Protection off (app-level auth instead). Deploy docs in `apps/catalog/README.md` including the Hobby constraints (noncommercial, personal repo, one deployer).

## Acceptance
- Sixth invite refused; used link refused; every non-public route redirects without a session.
- Template page shows version and checksum equal to the release asset.
- Lighthouse accessibility ≥ 95 on Home, Template, Install.
- Database contains no field for career data; a test asserts the schema.
- `vercel build` succeeds; a preview deployment URL in the PR.

## Out of scope
Any execution of workflows on the server. Analytics. Billing. Marketplace features.

## Report

### 2026-09-22 — Part A, Revision 1 (review fixes; iter-002 implementer, Sonnet)

Review verdict was REVISE: 3 issues from the Opus reviewer, 4 from the UI critic, plus 8 smaller fold-ins. This is the one revision round; all of them are fixed on `packet/P09-A` in the same worktree. New head: `75f0744de0723435746eec298a3aeeb04ce669a2`, CI green.

**The worst bug (UI critic):** every `/learn/<lesson>` and `/learn/assets/*` request 500'd for a signed-in user (404 for a missing file and a redirect for a revoked session also came out as 500s). Root cause: `getActiveSession` was wrapped in React's `cache()`, which is keyed to an active Server Component render; the `/learn/[...slug]` route handler called it directly, outside any render, so `next/headers`'s `cookies()` couldn't find its request context and crashed before the handler's own 404/redirect logic ever ran. Fixed by having the route handler read the cookie off the `NextRequest` it already has (`getActiveSessionFromCookieValue`) instead of calling `cookies()` — no ambient context needed, and directly unit-testable. New `tests/learn-route.test.ts` (6 tests) proves 200 + correct content-type for a valid session, 404 for a missing file, and a redirect for both a revoked and a missing session, calling the real exported `GET` against the real `getDb()` singleton (temp on-disk PGlite per test, not the in-memory test helper — there's no db parameter to inject into a route handler). Also made lesson 0001's `../MISSION.md` link resolve: `docs/learn`'s top-level `MISSION.md`/`NOTES.md`/`RESOURCES.md` now serve through the same `readdirSync`-built allowlist as everything else. Verified live: the previously-500ing lesson now renders fully styled (course.css/quiz.js load correctly), the MISSION.md link works (`text/plain`, real content), and a revoked/signed-out visit redirects instead of crashing.

**Five-invite cap race (reviewer, medium):** `WHERE (SELECT count(*) FROM invites) < 5` let two concurrent creates under Neon's READ COMMITTED isolation (each HTTP query its own transaction) both read count=4 and both insert — PGlite's single connection hid this in every test. Added `invites.slot SMALLINT UNIQUE CHECK (slot BETWEEN 1 AND 5)`; the INSERT claims the lowest free slot or falls back to 0, which always fails one of the two constraints, caught and treated as "refused". New test proves a sixth row is refused even by direct SQL (bypassing the service entirely), and via a colliding slot. Fixed the wrong comment that called this "a single-owner admin action, not a high-concurrency path". Also combined `acceptInvite`'s UPDATE+INSERT into one statement via a data-modifying CTE (fold-in a), so a failed INSERT can no longer burn an invite that never got a session; and gave sessions a real `expires_at` (30 days, the same constant the cookie's max-age already used) enforced in `findActiveSession`'s WHERE clause (fold-in c), tested by back-dating it directly since it's computed via `Date.now()` and PGlite's own `now()` doesn't observe faked JS time.

**Admin Dismiss didn't clear the flash cookie (reviewer + UI critic):** the flash cookie is set with `path: "/admin"`, but `cookies().delete(name)` emits `Path=/` — a browser only removes a cookie when the deletion's path matches exactly, so the "shown once" invite link kept reappearing. Fixed with `cookies().delete({ name, path: "/admin" })`. Verified two ways: a unit test injecting a fake cookie store, and live in the browser (create invite → Dismiss → full page reload → link stays gone, not just removed client-side).

**Checklist button names (UI critic, a11y):** all five toggle buttons announced as indistinguishable "Mark done"/"Undo", with the name also flipping across states. First fix used `aria-label={item.label}`, which satisfied the ARIA APG toggle-button pattern but — caught by a fresh Lighthouse run, not by guessing — failed axe's `label-content-name-mismatch` (WCAG 2.5.3 Label in Name: the visible text must appear in the accessible name, and `aria-label` replaces rather than extends it) on all five buttons. Landed on the coordinator's other suggested option instead: a visually-hidden item-label prefix inside the button, so the accessible name becomes e.g. "Node 24 present — Mark done" — distinct per item *and* containing the visible text verbatim. Re-ran Lighthouse after: that audit's `scoreDisplayMode` went from `"binary"`/0 on all five elements to `"notApplicable"` (nothing left to flag).

**Refusal messages (UI critic a11y + reviewer security):** no `role="alert"`, no `aria-invalid`/`aria-describedby`, focus stayed on `body` — and `?error=` was reflected verbatim from the URL, so anyone could craft a link putting arbitrary text in the "Refused" box. New `lib/error-messages.ts` maps a small fixed set of CODES (never free text) to fixed, server-authored copy, with an unrecognized code always falling back to one generic message. Applied on both `/admin` and `/invite`: the message box is now `role="alert"` with `tabIndex={-1} autoFocus`, and the relevant field gets `aria-describedby` (always, when an error shows) and `aria-invalid` (when the error is actually about that field). Reworded the invite-limit message to drop its false "Revoke one before creating another" claim (fold-in b — no revoke control exists or is planned for v1).

**Smaller fixes:** display names now reject `\p{Cf}` (fold-in d — covers every bidi control plus zero-width joiners/BOM, which could otherwise visually reorder or disguise a name), tested. Install commands: the full-clone path now carries its own `cd workflow-catalog/runner` instead of a shared (and wrong-for-that-path) `cd runner`, and the extension step says where the extension comes from for both the degit and full-clone paths (fold-in e). `pre.command-block` now wraps (`white-space: pre-wrap; overflow-wrap: anywhere`, matching the prototype's own `pre` rule) instead of `overflow-x: auto` — at 390px a command overflowed its box and axe flagged the resulting scrollable region with no keyboard access as serious; verified at 390px that `scrollWidth === clientWidth` now (fold-in f). One shared `button/.button/a:focus-visible` rule using `var(--ring)` (fold-in g). `button.ghost` → `button.ghost, .button.ghost`, since Home's "Owner sign-in" `<a className="button ghost">` was never matched by a selector requiring a literal `<button>` and rendered as a raised button; verified via computed style (`background: transparent`, `boxShadow: none`) (fold-in h). README step 6 corrected: `vercel build` alone produces no URL and needs `vercel pull` first — documented the real `vercel pull --yes --environment=preview` → `vercel build` → `vercel deploy --prebuilt` sequence, or deploying via git push; still not run (owner-gated).

**A flake found while re-verifying, unrelated to the review:** `tests/owner-cookie.test.ts`'s "rejects a tampered signature" tampered the cookie value's last character — also the last character of a 32-byte HMAC-SHA256 signature's base64url encoding, which (32 not being a multiple of 3) has 2 "don't care" padding bits that some substitutions don't actually change once decoded, occasionally making the "tampered" value verify as valid for reasons unrelated to `hmacVerify`'s correctness. Now tampers the signature's first character instead, which is never partial. Confirmed fixed by running the file 15 times clean (previously intermittent).

**Verify chain, twice** (in-worktree, and a fresh `git clone --branch packet/P09-A` + `pnpm install --frozen-lockfile`): `pnpm typecheck && pnpm test && pnpm -r lint && pnpm --filter catalog build && pnpm check:fixtures` — green both times, zero warnings. `apps/catalog` **87/87 tests** across 14 files (was 69/12; +18 net: 6 learn-route, 1 admin-flash, 3 learn top-level docs, 1 invites direct-SQL, 2 sessions expiry, 2 display-name bidi, 3 globals.css CSS-fact checks), `packages/contracts` 3/3.

**Lighthouse, re-run after all fixes:** Home **100/100**, Install **100/100** — and this time swept every individual audit (not just the weighted category score) for any sub-1.0 result regardless of weight: zero found on both pages.

**Live walkthrough (fresh dev server, throwaway secrets, PGlite reset):** admin sign-in → create invite → Dismiss (verified gone after reload) → accept as "Ada Quill" → install (ticked an item, reloaded, still ticked) → a learn lesson (previously 500, now renders fully styled; MISSION.md link resolves) → sign out → revoked-session redirect confirmed on the route handler specifically. Zero console errors throughout (aside from the pre-existing, unrelated `/favicon.ico` 404 every browser probes for automatically).

**Not done, still owner-gated:** same list as part A's original report — Vercel project creation, Neon Marketplace provisioning + migration, `OWNER_SECRET`/`SESSION_SECRET` in Vercel, Deployment Protection off, the real `vercel build`/`deploy`. Nothing in this revision changed that list.

**One thing to sharpen next time:** run a Lighthouse pass (not just a manual read) on every UI change before calling it done, even ones the review didn't explicitly ask for evidence on — the checklist-button `aria-label` attempt looked correct by the ARIA APG pattern alone, and only a fresh audit caught the WCAG 2.5.3 conflict it introduced.

### 2026-09-22 — Part A (iter-002 implementer, Sonnet)

**PR:** https://github.com/radroid/workflow-catalog/pull/4 (`packet/P09-A` → `overnight/integration`, head `06fe45f8af24d21aac898151009b7058253784b9`, CI green)

**What was done:** invite sign-in end to end (`/admin` owner dashboard gated by `OWNER_SECRET`, single-use invite links, 5-max limit, atomic accept via `UPDATE ... RETURNING`), a two-layer session gate (optimistic cookie check in `proxy.ts`, DB-backed revocation check in every gated layout/route), the install guide at `/install` (exact setup commands, persistent 5-item checklist, privacy statement), learn docs at `/learn` and `/learn/[...slug]` (allowlist built from a real `readdirSync()`, not string matching — structurally can't traverse outside it), and the light/dark theme from `docs/spec/visuals/theme.css` with Geist. Two-driver DB layer (Neon HTTP driver in production, PGlite embedded Postgres for local/dev/test) behind one `Db` interface, fail-closed if `DATABASE_URL` is unset on Vercel.

**Tests run, real output:** `pnpm typecheck && pnpm test && pnpm -r lint && pnpm --filter catalog build && pnpm check:fixtures` — run twice, once in-worktree and once from a fresh `git clone --branch packet/P09-A` + `pnpm install --frozen-lockfile`. Both green, zero warnings: `apps/catalog` 69/69 tests across 12 files, `packages/contracts` 3/3, lint clean, `next build` compiles all 7 routes, fixtures check 2/2.

**Lighthouse (accessibility category, headless Chrome, against a real session cookie obtained via the Server Actions progressive-enhancement form protocol over curl):** Home **100/100** (76 audits, `finalDisplayedUrl` confirmed `/`), Install **100/100** (76 audits, `finalDisplayedUrl` confirmed `/install`, i.e. it audited the authenticated page, not a redirect-to-home). Template is part B.

**Two bugs found live (neither caught by a unit test) and fixed:** (1) PGlite's own WASM asset-path resolution broke under Turbopack's Server Components bundling the first time a PGlite-backed route ran under `next dev` — fixed with `serverExternalPackages: ["@electric-sql/pglite"]` in `next.config.ts`. Vitest never exercised this path because it always uses in-memory PGlite outside Next's bundler. (2) the owner sign-in link rendered with a browser-default underline — fixed in `globals.css`.

**A test-infra fix also shipped in this PR:** PGlite-backed tests (`createTestDb()` → `new PGlite()`, a CPU-bound WASM instantiation) were intermittently timing out against Vitest's 5000ms default once several test files ran concurrently. Measured directly: 4.7s–7.9s per test at load average ≈ core count, zero assertion failures once given headroom. Added `apps/catalog/vitest.config.mts` with `testTimeout: 20000` and the measurement documented inline — no assertion, schema, or fixture was touched.

**Skipped, and why:**
- Part B in full: the template page (`workflow.json` rendering, version/checksum, download link) and `.github/workflows/release-package.yml`. Out of scope for this pass per the task split.
- Owner-gated deploy steps: creating the Vercel project, provisioning Neon via the Marketplace, running the migration against it, setting `OWNER_SECRET`/`SESSION_SECRET` in Vercel, turning off Deployment Protection, and the real `vercel build` / preview deployment. All documented step-by-step in `apps/catalog/README.md`; none require code changes, only owner action with real credentials.

**Assumptions:** install guide commands (`lib/install-commands.ts`) are written from the spec's description of `runner/` setup (P02 not yet landed), not verified against a real `runner/` — flag/script names may drift once P02 lands. Extension install step assumes "unpacked for now" per the deliverable text, since there's no private Web Store listing yet.

**One thing to sharpen next time:** the flash-cookie invite-link display (`lib/admin-flash.ts`) round-trips the plaintext token through an unsigned cookie between the create-invite redirect and the next page load — fine given it's short-lived (120s) and same-origin, but worth a second look during a security pass once P09-B's release flow exists, since that's the point invite distribution stops being purely manual copy-paste.

