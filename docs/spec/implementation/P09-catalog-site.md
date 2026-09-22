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
