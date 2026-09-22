# P09 · Catalog site on Vercel Hobby

Status: claimed (part A)
Assignee: iter-002 implementer (Sonnet), part A
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

