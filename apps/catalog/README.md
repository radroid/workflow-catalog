# catalog

The invite-only Next.js catalog site (`apps/catalog`), deployed on Vercel Hobby at a $0 target.
See `docs/spec/implementation/P09-catalog-site.md` for the packet this ships, and
`docs/spec/mvp-spec.md` §1/§3 (F1–F3) for the product contracts. Part A ships invite
sign-in, the install guide, and `docs/learn` rendering. Part B ships the template page
(`/templates/job-assistant`) and the release workflow that publishes the package it reads.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OWNER_SECRET` | Yes | Compared (timing-safe) against whatever the owner types at `/admin`. Any long random string. |
| `SESSION_SECRET` | Yes | HMAC key (via Web Crypto) for both the owner cookie and the friend session cookie. Any long random string, different from `OWNER_SECRET`. |
| `DATABASE_URL` | Production only | Neon Postgres connection string. Unset locally — the app falls back to an embedded PGlite store. **On Vercel, an unset `DATABASE_URL` is a hard error** (`lib/db/index.ts` refuses to fall back to PGlite when `process.env.VERCEL` is set). |
| `CATALOG_PGLITE_DIR` | No | Overrides where the local PGlite data directory lives. Defaults to `apps/catalog/.data/pglite` (gitignored). Point this at a fresh temp directory for isolated manual testing. |

None of these can be `.env*` files in this repo (denied by `.claude/settings.json`) — export them as shell
env vars, e.g.:

```sh
OWNER_SECRET=$(openssl rand -hex 32) SESSION_SECRET=$(openssl rand -hex 32) pnpm --filter catalog dev --port 3103
```

For local dev, secrets don't need to be identical between runs — they're only ever compared
against themselves. Losing them just invalidates any owner/session cookies already issued.

## Local development

```sh
pnpm install
pnpm --filter catalog dev --port 3103
```

No `DATABASE_URL` is needed locally: the first request that touches the database creates
(and self-migrates) a PGlite store under `apps/catalog/.data/pglite/`. Delete that directory to
start over. Never run `pnpm --filter catalog dev` on port 3000 — that's the owner's port
(see the repo root `CLAUDE.md`); this app defaults to whatever port you pass.

## Database

Exactly three tables — `invites`, `sessions`, `install_status` — defined in the one migration
file, `db/migrations/0001_init.sql`. No table has a column for career data; that's enforced by
a test (`tests/db/schema.test.ts`) that introspects `information_schema.columns` against an
exact allowlist.

- **Local/dev/test:** PGlite (`@electric-sql/pglite`, WASM, in-process, no build script). Every
  process that opens a fresh store runs the migration automatically (idempotent
  `CREATE TABLE IF NOT EXISTS`) — see `lib/db/migrate.ts`.
- **Production:** Neon Postgres via `@neondatabase/serverless`, driven entirely by
  `DATABASE_URL`. Neon is **not** auto-migrated — run `db/migrations/0001_init.sql` by hand
  once (Neon SQL editor, or `psql "$DATABASE_URL" -f db/migrations/0001_init.sql`) as part of
  the one-time project setup below.

## Owner-gated deploy steps (pending — not performed by this packet)

Creating cloud infrastructure and changing account-level settings are outward-facing actions
reserved for the project owner; the automated build loop never performs them. Build and tests
are verified locally/in CI against PGlite. To actually deploy:

1. **Vercel project.** Create a new Vercel project pointed at this repo with **root directory
   `apps/catalog`**. Hobby plan requirements: noncommercial use, a personal (not
   organization-owned) GitHub repo, and a single deployer — all already true of
   `radroid/workflow-catalog`.
2. **Neon Postgres.** Provision a Neon database through the Vercel Marketplace (free plan:
   0.5 GB storage, 100 CU-hours/month, scale-to-zero). Vercel sets `DATABASE_URL` on the
   project automatically when you do this through the Marketplace integration; verify it's
   present in the project's environment variables.
3. **Run the migration once** against that Neon database (see Database, above).
4. **Set `OWNER_SECRET` and `SESSION_SECRET`** as Vercel project environment variables — long
   random values (e.g. `openssl rand -hex 32`), not committed anywhere.
5. **Deployment Protection: off.** The app does its own invite/owner auth (spec F1); Vercel's
   own Deployment Protection would only add a second, redundant gate and — on Hobby — only
   supports a single external viewer, which would break the five-person pilot. Turn it off in
   the project's Deployment Protection settings.
6. **Deploy.** `vercel build` alone produces no URL — it only writes `.vercel/output/` locally,
   and needs the project's settings/env vars pulled first. From `apps/catalog`, with the
   project linked: `vercel pull --yes --environment=preview`, then `vercel build`, then
   `vercel deploy --prebuilt` to actually upload and get a preview URL. Or skip the CLI and
   just push to a branch — the linked Vercel project deploys previews on push automatically.
   Either way, confirm the preview URL loads `/` signed out.

None of steps 1–5 were performed by this packet. `vercel build` was **not** run locally either —
it requires a linked Vercel project (step 1), which is owner-gated. `pnpm --filter catalog build`
(the framework-only build, no Vercel project needed) was run and is green — see the PR.

## Learn docs

`/learn` and `/learn/<category>/<file>` render `docs/learn` (lessons and reference HTML, plus
their `assets/course.css` and `assets/quiz.js`) for signed-in sessions only, through a Route
Handler that reads from an allowlist built from the real directory listing — see `lib/learn.ts`.
`docs/learn` lives outside `apps/catalog`; `next.config.ts`'s `outputFileTracingIncludes` tells
the production build to trace those files too, since Vercel otherwise only uploads what a route
provably touches.

## Template page and package releases

`/templates/job-assistant` (session-gated, like `/install`) renders `packages/job-assistant/workflow.json`
— validated at module load with `@workflow-catalog/contracts`'s `workflowManifestSchema.parse`, so an
invalid manifest fails `next build`, not just a request at runtime — plus the current release's checksum
and download link, read live from the public GitHub REST API (`lib/release.ts`; unauthenticated, a 5s
timeout, Next's data cache revalidating hourly). Before any release exists, or if the API errs or times
out, the page says so instead of showing a broken link; it never falls back to any other source for the
download URL.

**`.github/workflows/release-package.yml`** packs `packages/job-assistant` into `job-assistant-<version>.tgz`
and publishes it as a GitHub release, triggered by pushing a tag `job-assistant@x.y.z`. It refuses to run
unless that version equals both `packages/job-assistant/workflow.json`'s `version` and
`packages/job-assistant/package.json`'s `version`, runs the package's own tests, and publishes the tarball
alongside a `job-assistant-<version>.tgz.sha256` file (`sha256sum`'s own `<hex>  <filename>` format) — the
template page reads its hex from that file's content, per mvp-spec.md F2's amendment: the checksum has to
be the tarball's own hash, published beside it, because nothing inside the tarball can hold a hash of
itself.

**The autonomous build loop never pushes a tag or creates a release** — `gh release create` is denied by
`.claude/settings.json` in every worktree, and pushing a `job-assistant@*` tag is exactly the action that
would trigger a real, outward-facing release. The owner pushes the first tag by hand once part B's PR is
merged: `git tag job-assistant@0.1.0 -m "job-assistant 0.1.0" && git push origin job-assistant@0.1.0`
(matching the version already in `workflow.json`/`package.json` today). Until that first tag is pushed,
the template page's checksum/download section correctly shows "Checksum and download appear with the
first release."

## Tests

`pnpm --filter catalog test` (Vitest). PGlite-backed integration tests cover the invite service,
the owner/session cookie gates, `proxy.ts`'s redirect behavior, the gated-layout revocation
check, the schema allowlist, and the learn-docs path-traversal cases — see `tests/`. Part B adds
the `workflow.json` manifest validation, the GitHub release fetch (mocked `fetch`: found, absent,
API error, timeout), and the `getDb()` cross-module-instance singleton (`tests/db/global-singleton.test.ts`,
which reproduces the dev-mode duplicate-PGlite bug with `vi.resetModules()`).
