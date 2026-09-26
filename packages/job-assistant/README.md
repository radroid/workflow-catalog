# @workflow-catalog/job-assistant

The portable, versioned job-application assistant workflow package (mvp-spec
§2, ARCHITECTURE.md). Provider-neutral: the only executed code is the eve
adapter (`adapters/eve/`), and that's a documentation stub until P02.

```text
workflow.json          name, version, required sources, connections, browser
                        permissions, actions allowlist, schemas list,
                        adapters, changelog — validates against
                        schemas/workflow.schema.json
skills/<name>/SKILL.md  eight Agent Skills-compatible prompts (onboarding
                        through revision-diff); each states its inputs and
                        outputs by schema name, its boundaries, and a
                        "## Never" section
schemas/*.schema.json   JSON Schema (draft 2020-12), generated from
                        @workflow-catalog/contracts by
                        `pnpm --filter contracts build` — never hand-edited;
                        schema-drift.test.ts in that package checks they stay
                        in sync with the zod source
templates/*.md.hbs      career-profile.md, resume.md, cover-letter.md
                        renderers — every claim/statement carries its claim
                        ID citation
fixtures/               fictional resume, cover letter, portfolio text, repo
                        summary, LinkedIn-style export, three job postings
                        (one hostile), expected claims, and index.json
                        mapping every fixture file to its schema
adapters/eve/README.md  how P02 mounts this package as an eve extension
test/                   contract tests for workflow.json, the fixtures
                        manifest, the skills, the templates, and package.json
```

Fictional fixtures only — see
`docs/spec/implementation/fixtures-policy.md`. Shared shapes (Claim,
CareerProfile, Source, JobSnapshot, Application, SessionManifest,
RunRecord, the bridge envelopes and HTTP bodies) live in
`@workflow-catalog/contracts`, not here — this package imports them via
`workspace:*`.

Shipped by packet **P01** (workflow package and contracts). Out of scope
for P01: any model call, any runner code — see
`docs/spec/implementation/P01-workflow-package-and-contracts.md`.
