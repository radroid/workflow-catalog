# Privacy checklist

Spec §7's rules, made concrete: what personal data this pilot creates, where
each piece lives, what ever leaves the machine, what the catalog stores, and
what `npm run setup -- --forget` removes. One line each, checkable against a
real install, with the file or code path that proves it.

## What personal data exists, and where it lives

- [ ] **The whole workspace is personal data**, in one folder the person
      chose (default `~/JobAssistant/`): `workspace.json`, sources, career
      profile, jobs, applications, sessions and run logs — proof:
      `docs/spec/mvp-spec.md` §5, and `runner/README.md`'s "Workspace layout".
- [ ] **Uploaded source files** (a resume, a pasted export, a dropped PDF or
      DOCX) sit under `sources/<category>/`. A PDF/DOCX's raw bytes are kept,
      dot-prefixed, so extraction prompts never re-read them — proof:
      `sources/<category>/.raw-<name>.<ext>` and "`ProfileStore.sourceText`'s
      existing dotfile skip" in `runner/README.md`'s Onboarding-page section.
- [ ] **The career profile** (`career-profile.json`/`.md`) holds every claim,
      its evidence, and the approval record — proof: `docs/spec/mvp-spec.md`
      §5, "Claim" and "**Session manifest**" paragraphs.
- [ ] **Captured job postings** are personal too (the runner doesn't know
      whether a posting names the person). Snapshots live at
      `jobs/<jobId>/snapshot-<rev>.json`, and every capture is also journaled
      once at `.runner/events/<eventId>.json` — proof: `docs/spec/mvp-spec.md`
      §5's workspace listing: "`events/` (the event journal; holds captured
      job text, so personal)".
- [ ] **Prepared documents and the name on them.** Resumes, cover letters and
      diffs live under `applications/<taskId>/docs/`; the name and contact
      line every document carries is `applications/details.json`, kept
      separate and **never sent to the model** — proof: `docs/spec/mvp-spec.md`
      §5 and `runner/README.md`'s Applications-page section.
- [ ] **`.eve/` is personal data, and it's unencrypted.** eve's own session
      store (`.eve/.workflow-data`) holds message content in plain JSON —
      proof: `runner/README.md`'s "Privacy" section ("the message content in
      it is unencrypted (spike)") and `docs/spec/research/eve-spike.md`'s
      "Session store is unencrypted" risk note.
- [ ] **Runner output is personal data, and it isn't written to a file.** eve's
      terminal output is prefixed `[eve]`; the runner writes no log files. A
      failed model call prints the **full request body** to that terminal
      output, so it's never safe to paste publicly — proof: `runner/README.md`
      "Privacy", and `docs/spec/research/eve-spike.md`'s "Prompt text in
      server logs" risk note.
- [ ] **The bridge logs operational lines only, never content.** — proof:
      `runner/README.md`'s "Extending the runner" (`ctx` doc: "Log operational
      lines only, never content.").
- [ ] **`.runner/model-check.json` holds no prompt or reply text** — only that
      a live check ran and its outcome — proof: the workspace-layout comment
      in `runner/README.md`.
- [ ] **Pairing tokens live in the extension's `chrome.storage.session`, never
      `storage.local`** — the device token, the last job capture, the outbox
      queue, and pairing-state flags all sit there, and nowhere else in the
      browser — proof: `extension/src/shared/storage.ts`'s header comment
      ("All ephemeral extension state, in `chrome.storage.session`
      exclusively — never `chrome.storage.local`") and `docs/spec/mvp-spec.md`
      §7 rule 5.
- [ ] **The runner stores only a hash of each pairing/device token**, not the
      token itself — proof: `runner/README.md`'s bridge section, "The bridge
      stores token hashes only."
- [ ] **Provider API keys live only in the OS keychain**, service
      `workflow-catalog-runner` — never in the workspace, `.env.local`, or the
      extension — proof: `docs/spec/mvp-spec.md` §7 rule 4, and
      `runner/README.md`'s "Provider" bullet under Setup.
- [ ] **A pasted GitHub token is kept the same way** — OS keychain, service
      `workflow-catalog-runner`, name `github-token` — and never reaches the
      workspace, the event journal, the UI, or any response — proof: the P03.1
      packet's Deliverables (`docs/spec/implementation/P03.1-onboarding-sources.md`)
      and `runner/README.md`'s Onboarding-page section (`lib/github-source.ts`).
- [ ] **ChatGPT credentials are never the runner's to store at all.** Codex
      owns that sign-in (`codex login`); the runner reads no ChatGPT secret —
      proof: `runner/README.md`'s "Provider" bullet and
      `docs/spec/mvp-spec.md` §8.

## What ever leaves the machine

- [ ] **Only the two model turns carry personal content off the machine**:
      job-posting extraction and application preparation, sent to whichever
      provider setup connected (ChatGPT via Codex, OpenAI, Anthropic, or a
      gateway) — proof: `docs/spec/mvp-spec.md` §7 rule 1 ("the configured
      provider receives selected content").
- [ ] **Even those two calls carry data as plain user-turn content, never a
      system prompt** — the posting's text, and confirmed claims by a
      position label (`[C1]`, never the claim's id or excluded/unconfirmed
      claims) — proof: `runner/README.md`'s Jobs-page and Applications-page
      sections ("delivered to the model only as user-turn data inside a
      random per-call boundary").
- [ ] **Hostile content in any source never becomes an instruction.** System
      prompts never interpolate raw source text; the model's only actions are
      `extract_claims`, `extract_job` and `prepare_application`, each of
      which checks and returns data — it never writes — proof:
      `docs/spec/mvp-spec.md` §7 rule 2, and `runner/README.md`'s Jobs- and
      Applications-page sections.
- [ ] **Everything else that reaches the network is the runner fetching
      public data the person asked for**, not personal data leaving: URL
      import and GitHub reads go out over `lib/safe-fetch.ts` (https only,
      SSRF-checked) or the GitHub API, and the browser extension talks only
      to `127.0.0.1:4310` — proof: `runner/README.md`'s Onboarding-page
      section and `extension/manifest.json`'s `host_permissions`.
- [ ] **The extension's permissions and host access are exactly the minimum**:
      `activeTab, scripting, tabGroups, storage, sidePanel, alarms`, and
      `host_permissions` naming only the runner's own loopback origin — no
      `tabs`, `debugger`, `<all_urls>`, remote code, or `eval` — proof:
      `extension/manifest.json` and `docs/spec/mvp-spec.md` §7 rule 3.

## What the catalog stores

- [ ] **Nothing personal, ever — enforced by a test, not just a promise.**
      The catalog's database has exactly three tables (`invites`, `sessions`,
      `install_status`); none has a column for career data, checked by
      introspecting `information_schema.columns` against an exact allowlist
      — proof: `apps/catalog/README.md`'s "Database" section and
      `apps/catalog/tests/db/schema.test.ts`.
- [ ] **The install page states this plainly**, including that the
      configured provider receives selected content — proof:
      `docs/spec/mvp-spec.md` §7 rule 1.

## How `npm run setup -- --forget` removes each item

- [ ] **`runner/.env.local`** (the provider selection, workspace path record,
      and route secrets) — removed — proof: `runner/README.md`'s "Uninstall"
      section.
- [ ] **`runner/.eve/`, `runner/.output/`, `runner/.nitro/`,
      `eval-agent/.eve/` and `.output/`** — removed — same section.
- [ ] **The whole workspace folder** — removed, unless `--keep-workspace` is
      passed, and only ever when its `workspace.json` still validates (so a
      folder that isn't really a workspace is left alone rather than
      guessed at) — same section. This also removes `.runner/` (the event
      journal, device/pairing records) and every uploaded source file,
      because both live inside the workspace folder.
- [ ] **The runner's own keychain entries** (the provider key, and
      `github-token` if one was ever pasted) — removed — same section.
- [ ] **eve's own sign-in is asked about separately, default no.** `--yes`
      never removes it; only an explicit terminal answer does. It covers the
      keychain entries under service `eve` (`chatgpt`, `openai-key`,
      `anthropic-key`, `ai-gateway-key`, `vercel`) and
      `~/.eve/connection.json` / `~/.eve/auth/chatgpt.json` — proof:
      `runner/README.md`'s "Uninstall" section, second list.
- [ ] **Codex's own ChatGPT sign-in is outside `--forget` entirely** — it
      belongs to Codex, not eve or the runner; remove it with `codex logout`
      — same section.
- [ ] **After `--forget`, deleting the cloned repo folder leaves nothing
      behind** — same section, closing line.
- [ ] **The extension's `chrome.storage.session` isn't touched by
      `--forget`** (it's the runner's command, not the browser's) — but it
      never survives a browser restart, reload or update on its own, so
      restarting Chrome, or removing the extension, already clears the
      device token, the outbox queue, the last capture, and pairing flags —
      proof: `extension/src/shared/storage.ts`'s header comment and
      `docs/spec/research/browser-boundary.md`'s "Sleeping, restart, and
      exactly-once limits" section. **Un-pair** (extension options page) or
      **Revoke** (runner's `/ui/status`) invalidate the token immediately,
      independent of either machine's cleanup — proof: `runner/README.md`'s
      bridge Pairing section ("Revoking a device … deletes it, and its token
      fails on the next request.").
