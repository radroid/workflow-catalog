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
- [ ] **Uploaded source files** (a resume, a pasted export) sit under
      `sources/<category>/`. **Per P03.1** (lands with that packet; today's
      merged Onboarding page accepts only pasted text and `.txt`/`.md`
      uploads), a dropped PDF or DOCX's raw bytes are also kept there,
      dot-prefixed, so extraction prompts never re-read them — proof (on
      `origin/packet/P03.1`): `sources/<category>/.raw-<name>.<ext>` and
      "`ProfileStore.sourceText`'s existing dotfile skip", in that branch's
      `runner/README.md` Onboarding-page section.
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
- [ ] **Per P03.1** (lands with that packet; `runner/lib/github-source.ts`
      doesn't exist on the merged tree yet), **a pasted GitHub token will be
      kept the same way** — OS keychain, service `workflow-catalog-runner`,
      name `github-token` — and never reach the workspace, the event
      journal, the UI, or any response — proof (on `origin/packet/P03.1`):
      the packet's Deliverables
      (`docs/spec/implementation/P03.1-onboarding-sources.md`) and that
      branch's `runner/README.md` Onboarding-page section.
- [ ] **ChatGPT credentials are never the runner's to store at all.** Codex
      owns that sign-in (`codex login`); the runner reads no ChatGPT secret —
      proof: `runner/README.md`'s "Provider" bullet and
      `docs/spec/mvp-spec.md` §8.

## What ever leaves the machine

- [ ] **Every provider turn that carries personal content, named:**
      onboarding claim extraction (`extract_claims`, the source text itself
      — a resume, an export, a statement — is the most personal content in
      the system: `runner/server/routes/onboarding.ts`'s
      `buildExtractionPrompt(category, sourceText)`), job-posting extraction
      (`extract_job`, the posting's text), application preparation
      (`prepare_application`, the posting's fields and confirmed claims),
      and the weekly-review schedule (a data-free prompt plus each open
      application's stage, task id and job id —
      `runner/scheduler/dispatch.ts`'s `runWeeklyReview`). All go to
      whichever provider setup connected (ChatGPT via Codex, OpenAI,
      Anthropic, or a gateway) — proof: `docs/spec/mvp-spec.md` §7 rule 1
      ("the configured provider receives selected content"). "Check the
      model" / `doctor -- --live` is content-free: it sends and checks for
      one fixed word, never workspace content.
- [ ] **Every one of those calls carries data as plain user-turn content,
      never a system prompt** — the posting's text, confirmed claims by a
      position label (`[C1]`, never the claim's id or excluded/unconfirmed
      claims), or (weekly-review) bare ids and stages — proof:
      `runner/README.md`'s Jobs-page and Applications-page sections
      ("delivered to the model only as user-turn data inside a random
      per-call boundary") and `runner/scheduler/dispatch.ts`'s
      `runWeeklyReview` comment.
- [ ] **Hostile content in any source never becomes an instruction.** System
      prompts never interpolate raw source text. Five of the six model tools
      (`ask_follow_up`, `extract_claims`, `extract_job`, `load_skill`,
      `prepare_application`) only check and return data; the sixth,
      `open_application_group`, is the one model action that writes — it
      creates the session and command files a browser session needs, gated
      by its own `approval: always()` — proof: `docs/spec/mvp-spec.md` §7
      rule 2, `runner/README.md`'s Jobs- and Applications-page sections, and
      `runner/agent/tools/open_application_group.ts`.
- [ ] **Everything else that reaches the network is the runner fetching
      public data the person asked for**, not personal data leaving: the
      Jobs page's URL fetch goes out over `lib/safe-fetch.ts` (https only,
      SSRF-checked); **per P03.1**, onboarding URL import and GitHub reads
      will use the same `safe-fetch.ts` path and the GitHub API. The browser
      extension talks only to `127.0.0.1:4310` — proof: `runner/README.md`'s
      Jobs-page section, `extension/manifest.json`'s `host_permissions`, and
      (for the P03.1 part) that packet's Deliverables on
      `origin/packet/P03.1`.
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
- [ ] **The runner's own keychain entries** (the provider key) — removed —
      same section. **Per P03.1** (lands with that packet;
      `Object.values(API_KEY_SECRET_NAME)` in `runner/lib/forget.ts` doesn't
      include it yet on the merged tree), `github-token` will be removed the
      same way if one was ever pasted.
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
      exactly-once limits" section. **These two are not equivalent, and only
      one invalidates the token on the runner's side:** **Un-pair**
      (extension options page) only deletes the browser's own copy
      (`chrome.storage.session`) — it makes no bridge request, so the
      runner's device record in `.runner/devices/<id>.json` stays active
      until it's revoked or expires (30 days) — proof:
      `extension/src/options/main.ts`'s Un-pair handler (`forgetPairing()`
      only) and `extension/README.md`'s own note ("**Un-pair** forgets the
      token … the page still links to `/ui/status` for actual revocation").
      Only **Revoke** (runner's `/ui/status`) invalidates the token itself —
      proof: `runner/README.md`'s
      bridge Pairing section ("Revoking a device … deletes it, and its token
      fails on the next request.").
