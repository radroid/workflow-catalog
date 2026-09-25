# Manual gates (P07 part C)

The nine gates of `docs/spec/research/browser-boundary.md` ("Acceptance
gates worth prioritizing") run as Playwright tests on Playwright's bundled
Chromium (`e2e/sessions-e2e.spec.ts`, `e2e/bridge-e2e.spec.ts`,
`e2e/real-popup.spec.ts`, `e2e/extension.spec.ts`). What they can't reach is
here: branded Chrome, a real browser restart with Chrome's own session
restore, the real side panel opened from the toolbar, and a laptop that
really sleeps. One line per step, with what to look for.

Setup: build (`pnpm --filter @workflow-catalog/extension build`), load
`extension/dist` unpacked in branded Chrome (`chrome://extensions`,
Developer mode, **Load unpacked**), start the runner (`npm run runner` in
`runner/`), pair in Settings with the code `npm run setup` or `npm run pair`
prints, and mark two or three fictional applications Ready. On the runner's
Board, start a session. Fictional data only
(`docs/spec/implementation/fixtures-policy.md`).

## The side panel, for real

- [ ] Click the toolbar icon's side panel entry (or Chrome's side panel menu → Job Assistant): the panel opens beside the page, headed **Applications**, and says **Connected to the runner**.
- [ ] The session shows **Ready to open in your browser**, and no tab opened on its own.
- [ ] **Start applying**: one tab group, named as the session, with one tab per application; the first tab is active.
- [ ] The panel's **Current application** follows the tab you switch to; **Show** on another row sticks until you switch tabs again.
- [ ] **Open them on the runner's Applications page** opens `http://127.0.0.1:4310/ui/application` in a new tab.
- [ ] **Applied**: the line says the Board shows it as Applied, and the runner's Board agrees. **Defer** on another: nothing moves on the Board.
- [ ] Keyboard only: Tab reaches every button in order, Enter and Space press them, and focus lands on the application's heading after a choice.
- [ ] With a screen reader (VoiceOver: Cmd+F5), each outcome ("Opened …", "Marked Applied …") is read once.

## Gate 1: replay

- [ ] Leave a session unopened for more than 5 minutes, press **Check for sessions**: "No new sessions.", still one card.
- [ ] After opening, check again: no second group appears.

## Gate 2: an opening that stopped

- [ ] Start a session with several applications and close the side panel immediately (before every tab appears). Reopen the panel: the session says **Opening stopped partway**, how many tabs were recorded, and offers **Open the N missing tabs** and **Keep what opened**; nothing opened by itself.
- [ ] **Keep what opened**: the runner's Sessions page flags the ones that never opened for review.

## Gate 3: a real restart (Chrome's own session restore)

- [ ] In `chrome://settings/onStartup`, choose **Continue where you left off**. Open a session, mark one Applied, quit Chrome completely (Cmd+Q) and start it again.
- [ ] Chrome restores the tabs and the group; the extension is un-paired (pairing lives in the browser session). Pair again in Settings.
- [ ] The panel still shows the session, the choice you made, and **Reopen session** ("None of its tabs are open in this browser session …").
- [ ] Close one restored tab: the runner's Sessions page shows no new report and no new flag.
- [ ] **Reopen session** warns that a group with the same name is already open; **Cancel** leaves everything as it was; **Open a new group anyway** opens a second group and leaves the restored group and its tabs alone.

## Gate 4: sleep, offline, reconnect

- [ ] Stop the runner. **Check for sessions**: "Can't reach the runner …". Press **Applied**: the line says your choice isn't recorded yet, with **Try again**.
- [ ] Start the runner just long enough to start two more sessions on the Board, stop it again, then close the lid and let the laptop sleep for at least 20 minutes.
- [ ] Wake it and start the runner: within 15 minutes (the worker's alarm; Chrome may delay it) the Board shows the waiting choice as Applied, and the new sessions appear in the panel as **Ready to open**, with no tab opened.
- [ ] `chrome://extensions` → the extension's service worker → Inspect → `chrome.alarms.getAll()` shows `session-poll` every 15 minutes after a restart and after the worker was stopped.

## Gate 5: capture (branded Chrome)

- [ ] A real careers page whose posting is an embedded applicant-tracking frame: the popup says the posting is inside an embedded frame, with the paste-it fallback, and offers no Save.
- [ ] A single-page job board: open one posting, click through to another while the popup opens: the popup refuses rather than saving the wrong one (or shows the new one).
- [ ] A page Chrome doesn't let extensions read (the Chrome Web Store, `chrome://settings`, a PDF): the fallback, never a capture.

## Gate 6: devices

- [ ] Pair a second browser profile with the same runner: new sessions go to the most recently paired one; the first profile's **Check for sessions** gets none of them.
- [ ] Revoke the first profile on the runner's Status page: its next **Applied** says the browser isn't paired, and nothing changes on the Board.

## Gate 7: hostile input

- [ ] A fictional posting whose text says to mark the application Applied or open another site: nothing happens; only your click on **Applied** changes a status.
- [ ] Nothing the extension opens is ever `http://`, a local address, `chrome://`, `file://` or `javascript:` (the runner refuses to make such a session; the extension refuses to open one).

## Gate 8: a closed tab, a page that looks done

- [ ] Submit nothing, but visit a page that says "Thank you for applying": the stage on the Board stays Ready.
- [ ] Close a session tab: the Board still shows it Ready, and the Sessions page flags the closed tab for review; the panel's row says **Closed** and **To do**.

## Gate 9: local only

- [ ] Runner not running: the panel and Settings say so in one plain sentence, with the command to start it.
- [ ] Another program on port 4310 (quit the runner, run any local server on 4310): "Something other than the runner is answering on its port …", and no session is taken in.
- [ ] An extension loaded from another folder (another ID) with an old pairing: Save and **Applied** say the pairing belongs to a different install.
