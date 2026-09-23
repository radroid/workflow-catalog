# P03 (#11): round-4 review of head fbb6444 (iter 005)

A narrow confirmation round over revision 3 (bbfa00e..fbb6444, decisions J1–J8 in `logs/handoff/P03-round-3-review.md`). The UI critic's section is added when its verdict lands.

## Reviewer (Opus): APPROVE (no issues, 5 nits, 1 follow-up)

Scratch: `/tmp/p03-r4-review/`:
- chain logs `head-*` and `merge-*`, and `merge-clone/`;
- probes `zz-reviewer-*.test.ts`, with their evidence files;
- `mut/` (`specs4.mjs`, `run4.mjs`, `mutations4.log`);
- `repeat-ui-pages.log`.

**What holds:**
- **J1:** round 3's probe G1, re-run with the real `Client`, passes 11/11.
  - `turn.cancelled` is not ok, records no hash, and a re-extract opens a new stream.
  - The normal sequence is the ok control.
  - The S1 plant is killed.
- **J7:**
  - N1: three queued writers get their 503s at about 5.0 s, where round 3 saw 5, 10 and 15 s.
  - N6: 8 hostile marker variants round-trip, and an unchanged save succeeds.
  - N2–N4 and N7 each have a killed plant.
- **J3 and J5, the server side:**
  - While the file is unreadable, 9 write routes return 409 with the one short line, and extract has its own line.
  - Saving source text and uploads still works.
  - Every problem starts "Line N:", with no marker id.
  - The on-disk view is confined: fixed name, a symlink out gives 500, and it needs the cookie and the same origin.
- **J4:** the DOM test is deterministic (15/15), runs in CI, and fails on both rebuild plants. In the reviewer's probe, each outcome is announced once and focus moves without passing through `<body>`.
- **Authorization note:** it can't happen today. `runner/agent` has no connections, MCP clients or subagents, and `defaultTools: false`.
- **Merges:** the readdir test loads `runs`. The diff of the 9 P08-A files against 360ac69 is empty. The prompt file is unchanged.
- **Chain:**
  - green at fbb6444 (runner 561, eval 5/5 with 85 gates) and on the merge onto 86b77a3;
  - CI 35927592376 passed;
  - scope: 85 files, all allowed.

**Nits (carried to P03.1):**
1. The on-disk view has no size limit (`store/profile.ts:364`). Send it up to `MAX_MARKDOWN_BYTES` (512 KiB), and null beyond that.
2. On Profile, `run()` (`profile.js:254-268`) never clears `editorError`, so after an unrelated Accept the editor keeps its red error. Clear it, or record the exception. The UI critic judges this one.
3. Two defensive paths have no committed test: `clip` (R5, `profile-markdown.ts:353`) and `nestedLine`'s escape (R6, `:131`). Add the reviewer's probes 2 and 3 as tests.
4. The DOM test checks only the line's final text. Add a count on `#last-action`, so it asserts "announced once".
5. The file-edit prefix (`profile.ts:192-199`, `:347`) can push a message to 106 characters.

**Follow-up:**
- `ui-pages.test.ts:67` loads happy-dom from the extension's install. That's acceptable for now: it's pinned at 20.14.5 and CI runs the test.
- P03.1 adds `"happy-dom": "20.14.5"` to the runner's devDependencies. It already owns `runner/package.json` and the lockfile.
