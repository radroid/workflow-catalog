# Follow-ups from the manual session's merge gate

One line each: packet, finding, file. The orchestrator appends this list at each merge; implementers and reviewers never edit it. Follow-ups never become new packets or grow another packet's scope. The list is triaged once, in `OVERNIGHT-REPORT.md`.

- P05 · F1: through Z6, a claim's joined bracket that mentions someone else's role states that title. With "Platform Engineer (Senior, reporting to the CTO) at Fernwood Labs", "Served as CTO at Fernwood Labs from 2019 to 2021 [C11]." passes (refused at 451398e; the unbracketed claim already let it pass). · `runner/validate/facts.ts`
- P05 · F2: a cost of Z6: "Platform Engineer (Senior, reporting to the CTO) at Fernwood Labs, 2019–2021 [C12]." is refused ("cto") against a claim without that bracket. · `runner/validate/facts.ts`
- P05 · F3: a cost of Z7: an adjective before "scores" (high, low, top, perfect, …) no longer makes it a noun, so "Kept perfect scores of 100 …" is refused as the quantity "scores of". · `runner/validate/facts.ts`
- P05 · F4: a cost of Z7: a determiner before a noun use counts, so "Kept the scores of each Lighthouse accessibility audit … at 100 [C13]." is refused. · `runner/validate/facts.ts` (`scoresIsNoun`)
- P05 · F5: a cost of Z8: "I am the engineer on call for the payments infrastructure team at Northwind Labs [C1]." is refused ("engineer"), like the recorded Z3 cost for "I was". · `runner/validate/facts.ts`
- P05 · F6: revision 5 has no report of its own; the gate note in the packet's Report and `/tmp/wc-manual/P05-gate-review.md` stand in for it. · `docs/spec/implementation/P05-preparation-and-validator.md`
- P06.1 · F1: K3's counted form (it names the first failure when not every name fits) has no test. `runner/ui/assets/jobs.js:953`, `runner/test/jobs-page-followups.test.ts`
- P06.1 · F2: K4's third case (focus on the posting text itself) has no test. It works live. `runner/test/jobs-page-followups.test.ts`
- P06.1 · F3: The K4 test's title says "…and a chmod'd directory does the same", but its body never chmods. The report's K4 entry says the body covers a chmod'd directory. `runner/test/jobs-page-followups.test.ts:290`, `docs/spec/implementation/P06.1-jobs-and-status-followups.md`
- P06.1 · F4: The report says all 32 shots are at scale 2 (780×1688 or 2560×1800). 12 are at scale 1, though every width is true. It also calls the kept Jobs shots "already correct", but two sets predate K3 and K7. `docs/spec/implementation/P06.1-jobs-and-status-followups.md`
- P06.1 · F5: At 390, the two-line clamp cuts the K5 refusal before the file name ("…(jobs/fc0717d2-a1b1-4ad9-a8c…"). The full text is in the live region and `title`. `runner/ui/assets/jobs.js:1074`
- P06.1 · F6: `clearUnreachable` leaves a stale "Can't reach the runner" line if a watched job disappears during the outage. `started.size > 0` at clear time, and the settle step then drops that entry silently. Adversarial. `runner/ui/assets/jobs.js:982`
- P06.1 · F7: The shared `code { overflow-wrap: anywhere }` breaks short ids mid-id in tables (the Status device id "b92ef / 9da" at 390). This is a net improvement over the old 14 px card overflow. `runner/ui/assets/runner.css:63`
- P06.1 · F8: The Status devices table at 390 still puts Revoke about 11 px past the card's padding. Pre-existing, and reduced by K10. `runner/ui/status.html`, `runner/ui/assets/runner.css`
- P06.1 · F9: `#page-error` on Status is never cleared once an action succeeds, so a runner-down message stays after recovery. Pre-existing. `runner/ui/assets/status.js:29`
- P06.1 · F10: There are no Status screenshots of the busy state (K9's target page), the K8 "Can't reach the runner" result, the Fix-line `<code>`, or K11's pairing errors. All were checked live. `docs/screenshots/`
- P06.1 · F11: The report notes an unhandled rejection: the initial `Promise.all(…).catch(showError)` resolves after the test window closes. It didn't reproduce here, but it can flake CI. `runner/test/status-page-followups.test.ts`, `runner/ui/assets/status.js:171`
- P06.1 · F12: The 1280 `P03.2-status-model-check-failed-*` and `P06.1-status-model-check-success-*` shots predate K8's `<code>` eve URL. They are stale, but still meet 4.3's goal (no setup line). `docs/screenshots/`
