# Follow-ups from the manual session's merge gate

One line each: packet, finding, file. The orchestrator appends this list at each merge; implementers and reviewers never edit it. Follow-ups never become new packets or grow another packet's scope. The list is triaged once, in `OVERNIGHT-REPORT.md`.

- P05 · F1: through Z6, a claim's joined bracket that mentions someone else's role states that title. With "Platform Engineer (Senior, reporting to the CTO) at Fernwood Labs", "Served as CTO at Fernwood Labs from 2019 to 2021 [C11]." passes (refused at 451398e; the unbracketed claim already let it pass). · `runner/validate/facts.ts`
- P05 · F2: a cost of Z6: "Platform Engineer (Senior, reporting to the CTO) at Fernwood Labs, 2019–2021 [C12]." is refused ("cto") against a claim without that bracket. · `runner/validate/facts.ts`
- P05 · F3: a cost of Z7: an adjective before "scores" (high, low, top, perfect, …) no longer makes it a noun, so "Kept perfect scores of 100 …" is refused as the quantity "scores of". · `runner/validate/facts.ts`
- P05 · F4: a cost of Z7: a determiner before a noun use counts, so "Kept the scores of each Lighthouse accessibility audit … at 100 [C13]." is refused. · `runner/validate/facts.ts` (`scoresIsNoun`)
- P05 · F5: a cost of Z8: "I am the engineer on call for the payments infrastructure team at Northwind Labs [C1]." is refused ("engineer"), like the recorded Z3 cost for "I was". · `runner/validate/facts.ts`
- P05 · F6: revision 5 has no report of its own; the gate note in the packet's Report and `/tmp/wc-manual/P05-gate-review.md` stand in for it. · `docs/spec/implementation/P05-preparation-and-validator.md`
