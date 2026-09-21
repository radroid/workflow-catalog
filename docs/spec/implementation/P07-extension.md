# P07 · Chrome extension

Status: open
Assignee: none
Blocked by: P02 (pairing and bridge), P06 (manifests and commands)
Owns: extension/
Spec: F6 (capture path), F9, §7 rule 3, browser-boundary.md (all sections; the nine gates are this packet's definition of done)

## Goal
Capture the current posting, open an application session as a tab group, show the side panel, and report explicit status, within the MV3 boundary the research established.

## Deliverables
- `manifest.json`: `manifest_version: 3`, `minimum_chrome_version: "120"`, permissions exactly `activeTab, scripting, tabGroups, storage, sidePanel, alarms`, host permission only `http://127.0.0.1:4310/*`. No `tabs`, no `<all_urls>`, no remote code, no eval.
- Pairing (options page): enter the code from `npm run setup`, receive a device token into `storage.session`, show device name, allow un-pair.
- Capture: action click → packaged extractor via `scripting` under `activeTab` → bounded text + structured hints → preview → Save → `job_capture` event with content hash. Paste/upload fallback link to the local UI.
- Session: poll `GET /commands` on panel open and via an alarm (15-minute cadence, recreated on startup); on a user gesture open the group (`tabs.create` + `tabs.group` + `tabGroups.update`), journal intent before creating tabs, record returned IDs in `storage.session`, acknowledge per item; never auto-open from an alarm.
- Side panel: current task's job, prepared documents (links to the local UI), remaining steps, `Applied` / `Defer` buttons → `application_status_changed` with expected revision. Closing a tab sends only `closed`.
- Restore: "Reopen session" reads the manifest; warns if a group with the same title exists; never adopts arbitrary tabs.
- File bridge fallback: export `job-capture.json`, import `application-session.json`, export completion events.
- Playwright tests on bundled Chromium (persistent context) + a manual smoke script for branded Chrome.

## Acceptance
The nine gates from browser-boundary.md as automated tests where possible (replay, worker kill between journal and record, restart with restored tabs, offline/reconnect, capture-navigation/denial/iframe fallback, two devices + revoke + expired token, hostile/oversized/privileged inputs rejected, closed tab and "success-looking page" leave status unchanged) and a checklist for the manual ones. Manifest diff test: permissions equal the six exactly.

## Out of scope
Form filling, uploads, submission, cookies, native messaging.
