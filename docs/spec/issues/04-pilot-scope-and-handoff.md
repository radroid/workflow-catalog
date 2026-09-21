# Which limits make the first build small and complete?

Type: grilling
Label: wayfinder:grilling
Status: resolved
Assignee: orchestrator (Claude, 2026-09-20)
Blocked by: none
Parent: ../map.md

## Question

Confirm pilot size/commercial intent, spending currency and ceiling, browser-action scope, connection priorities, and the definition of complete before handing the specification to implementation sessions. Which behaviors must ship together for a friend to adopt and own one workflow?

## Comments

- Hosted execution and $25 operating ceiling were explicitly selected by the user.
- User confirmed five people, noncommercial pilot, daily background preparation, browser capture/open/groups plus manual submission. Full career-context onboarding is required before generation.
- Remaining: visually review the proposed onboarding and determine whether the $25 ceiling means USD before tax or CAD/all-in. No paid setup should infer this currency decision.
- 2026-09-20: execution direction settled as "guided local path first" (ticket 05), which moves inference cost onto each person's own subscription or key.

## Answer

- **Pilot:** five people (owner + four invited friends), personal and noncommercial, invite-only. Noncommercial use is also what keeps Vercel's Hobby tier permissible (verified in ticket 01).
- **Money:** the $25/month ceiling is read as **USD, before tax**, for hosted line items only. Target is $0 (Hobby tier, no custom domain required). Inference is each person's own subscription or API key and is *not* charged to the owner. **Assumption to confirm:** if the ceiling was meant as CAD or all-in, say so; nothing paid is provisioned until then.
- **Browser scope:** capture the current page's job posting, prepare materials, open an application session as a Chrome tab group, record *explicit* Applied / Deferred status. No form filling, file upload, or submission in the MVP.
- **Connection priorities (MVP):** file upload (PDF/DOCX/MD), pasted text, public URL import (portfolio, personal site), and GitHub (read-only, via token) for repositories. LinkedIn and other social platforms are covered by **exported data files**, never scraping. A source the person cannot or will not provide is recorded as *unavailable* or *not applicable*, which still counts as "accounted for".
- **Definition of complete (the success test):** an invited friend, on their own machine and provider, installs from the catalog in about 30 minutes, accounts for every source category, resolves or excludes every candidate claim, approves their career profile, captures three real jobs, gets prepared resumes in which every claim traces to a confirmed claim ID, opens the tab group, and marks applications Applied — with the workspace still entirely local.
- **Must ship together:** onboarding + career profile; job capture (extension and paste); preparation with evidence trace; application session + tab group; explicit status; catalog install page; teaching docs. **Ships if it doesn't slip:** daily scheduled preparation (on-demand "Prepare all" covers the pilot).
- **Handoff shape:** bounded packets in `implementation/`, each claimable by one agent session, plus one overnight prompt. See [implementation/README.md](../implementation/README.md).
