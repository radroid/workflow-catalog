# Browser execution boundary

Research date: 2026-09-20. Scope: five-person private pilot; capture jobs, prepare documents, open tab groups; people fill and submit applications. Findings below preserve the hosted option. Downloadable local workflows are an alternative under discussion, not an approved architectural replacement. Recommendations are identified as design choices, not Chrome guarantees.

## Recommended hosted boundary

Keep career context, generation, schedules, application state, and a durable browser-action queue in the hosted service. The extension performs short local operations. A scheduled run prepares materials while the computer is off; it cannot open tabs on an unavailable computer. Show “Ready to open in your browser,” then open a group after the user selects **Start applying**. This architecture needs no cloud browser. Local browser operations add no metered browser-provider charge; hosted storage, requests, and LLM inference remain separate costs.

The extension side panel shows the job, prepared documents, missing information, and explicit **Applied / Defer** controls. Closing a tab records only that the tab closed. A page claiming success is not authoritative application completion.

## API surface and minimum permissions

Proposed minimum manifest:

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "120",
  "permissions": ["activeTab", "scripting", "tabGroups", "storage", "sidePanel", "alarms"],
  "host_permissions": ["https://YOUR-PRODUCTION-APP.vercel.app/*"]
}
```

The named hostname is replaced during packaging; development origins belong in a separate development build. Host permission lets the worker contact the API. Content scripts do not inherit this cross-origin network privilege. [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

`activeTab` grants temporary page access after invoking the extension, and `scripting` permits a packaged extractor. Use the action click to capture a bounded text/structured-data snapshot, preview it, then save. Navigation to another origin revokes access. A persistent side panel alone must not be treated as permission to read every newly active tab. Offer paste/upload fallback for unsupported pages, inaccessible frames, or missing permission. [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

Creating tabs does not require the broad `tabs` permission; that permission primarily unlocks sensitive tab metadata. Group using `tabs.group`, then name/color the group using `tabGroups.update`. [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)

The side panel requires `sidePanel`; programmatic opening requires a user interaction. Configure the toolbar action to open it; do not attempt to force it open from an alarm. [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

Exclude `debugger`, cookie access, `<all_urls>`, automatic form filling, file upload, and submission capabilities from this release. Capture only the job content users elect to save. Chrome limits browsing-data collection to described user-facing features. [User-data policy](https://developer.chrome.com/docs/webstore/user_data)

## Sleeping, restart, and exactly-once limits

Workers normally stop after 30 seconds idle, after a single operation exceeds five minutes, or when a fetch response takes over 30 seconds. Persist operation checkpoints; register event listeners at module scope; never keep the task queue solely in globals. Long inference runs belong in the hosted runtime. [Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

Alarms can be delayed, do not wake sleeping devices, and missed repeating alarms coalesce. Chrome 120 permits 30-second periods; the proposed pilot should instead refresh periodically, e.g. every 15 minutes, plus on panel opening. Check/recreate alarms on startup instead of assuming persistence across all supported versions. No exact-time browser promise. [Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

Use durable UUIDs for application, session, device, and command records. Chrome tab/group IDs are unique only within a browser session. Store current mappings in `storage.session`, whose lifetime survives worker sleep but not browser restart, reload, or update. Store nonsecret manifests/checkpoints in `storage.local`. [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups), [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

Design choice: MVP restoration means **explicitly reopen the saved task manifest**, not silently adopt arbitrary browser-restored tabs. Warn that an existing restored group may already be present; leave existing tabs alone. Reliable automatic reattachment would need additional identity/reconciliation work and potentially optional `tabs` permission. Group titles and URLs alone are ambiguous.

There is no transaction spanning browser tab creation and our database. A crash after creating a tab but before recording its ID creates uncertainty. Never promise exactly-once opening. Journal intent first, record returned IDs, deduplicate completed commands, and surface unresolved partial sessions for user review instead of blindly replaying them.

## Pairing and token handling

Design recommendation: device-style pairing avoids importing site cookies. The extension obtains a high-entropy device secret and a short user code; the user signs in on the hosted site, confirms the matching code and device name, and approves pairing. Expire attempts after ten minutes, rate-limit codes, make approval single-use, and respect polling backoff. Follow the device-flow security principles, particularly protection against code guessing and phishing. [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)

Issue short-lived, device-scoped access tokens; authorize every application/command against the authenticated user. Keep access tokens in `storage.session`. If persistent sign-in is required, use a rotating refresh credential restricted to trusted extension contexts, with revocation and reuse detection. Extension storage is not encrypted; store no LLM provider keys or full career archive there. Server stores credential hashes; never put tokens in URLs or content-script messages. [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700), [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), [Chrome privacy guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy)

Content-script output is untrusted input. Validate message type, sender, size, and schema. Worker endpoints must be fixed, not arbitrary fetch proxies. Revoke paired devices from the account page. [Chrome security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)

## Minimal protocol contract

Illustrative envelopes; IDs and signatures are not authorization by themselves:

```json
{
  "protocol": 1,
  "commandId": "uuid",
  "deviceId": "uuid",
  "sessionId": "uuid",
  "workflowVersion": "job-assistant@1",
  "type": "open_application_group",
  "expiresAt": "ISO-8601",
  "payload": {
    "title": "Apply today",
    "items": [{"taskId": "uuid", "jobRevision": 3, "url": "https://jobs.example/apply/123"}]
  }
}
```

```json
{
  "protocol": 1,
  "eventId": "uuid",
  "commandId": "uuid",
  "type": "browser_command_result",
  "status": "completed",
  "items": [{"taskId": "uuid", "status": "opened"}],
  "occurredAt": "ISO-8601"
}
```

Separate `job_capture` carries capture ID, URL, timestamp, bounded text, extractor version, and content hash. Separate `application_status_changed` carries task ID, expected revision, and explicit user-selected status. Server derives identity from authentication, uses unique event IDs for retries, and rejects stale revisions. Keep ephemeral Chrome IDs local.

Allowlisted commands are **capture after local invocation**, **open approved group**, and **report explicit status**. Validate command expiry, device binding, workflow version, task ownership, URL scheme, and maximum group size; reject `javascript:`, local files, privileged browser URLs, and arbitrary code. Bind commands to stored job URLs; allow URL changes only through reviewed capture/update. Poll/claim with an expiring device lease; acknowledge per item. Unknown or partial results require review. These are application design requirements.

## Shared skills versus remotely downloaded code

MV3 does not permit remotely fetched executable JavaScript/WASM in the extension. JSON/data and instructions are different, but permitted remote configuration must stay within predetermined execution paths. Therefore shared workflows contain prompts, schemas, references, and names of packaged actions. Updating extraction/action code means updating the extension package. Do not implement `eval`, remote script injection, or a general “run this script” tool. [Remote-code rules](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code), [MV3 resolved issues](https://developer.chrome.com/docs/extensions/develop/migrate/known-issues)

## Distribution and verification

An overnight build can produce an unpacked extension loaded manually through Developer Mode. This is appropriate for developer verification, with installation/update friction for friends. [Official unpacked installation tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)

For the five-person pilot, prefer a private Web Store listing with trusted testers when ready; unlisted means anyone with the URL can install, so account invitations remain essential. Every visibility mode receives policy review. Registration is a one-time fee; Google's current update notes reference $5. Treat store review timing and registration as release dependencies, not something an overnight agent can guarantee. [Distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [Registration](https://developer.chrome.com/docs/webstore/register), [Chrome update notes](https://developer.chrome.com/docs/extensions/whats-new)

Playwright extension tests require persistent Chromium contexts. Its docs instruct using bundled Chromium because branded Chrome/Edge removed command-line extension side-loading flags. Use automated Chromium tests and a manual regular-Chrome installation smoke test; verify real toolbar gestures and native side-panel behavior manually. [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)

## Alternative under discussion: downloadable local workflows

| Approach | What it provides | Main tradeoff |
|---|---|---|
| Download + user's existing harness | Versioned skill bundle, context files, prompts, reviewed local scripts; manual job/document exchange | Lowest platform runtime cost; no automatic bridge or computer-off execution |
| Extension alone + manual imports | Capture/export jobs; import prepared task JSON; open groups | Useful standalone tool, but cannot launch a local CLI by itself |
| Local companion + extension | Runs chosen harness, stores context locally, exchanges tasks through a bridge | Installer, credentials, upgrades, support, and availability become product responsibilities |
| Hosted runtime + extension | Shared service prepares while laptops are off | Platform pays/budgets inference and hosting |

**Recommended first experiment if the user selects local execution:** use a manual file bridge before a companion daemon. The extension exports `job-capture.json`; the user's harness imports it into the canonical local workspace, prepares documents, and writes `application-session.json`. The user imports that declarative manifest into the extension and opens its group. Export completion events back to the workspace explicitly. This tests whether downloadable workflows are useful without promising arbitrary-harness browser control.

Define the artifact contract with `schemaVersion`, `workspaceId`, `workflowInstanceId`, `sessionId`, `taskId`, `revision`, generated timestamp, and bounded HTTPS job URLs. Documents stay in the workspace; the manifest lists artifact IDs/names, not executable file paths. Treat imports as untrusted data. The local workspace is authoritative; the extension is a session projection plus an event outbox. Completion exports carry unique event IDs and expected task revisions; the workspace deduplicates and resolves conflicts. Show **Changes not yet synced to your workspace** until an explicit reconciliation import acknowledges them. Importing an old manifest must not overwrite newer local completion events. File transfers and local scheduling remain manual/locally available; this is a deliberate usability tradeoff to validate with friends.

Design choice for a companion: favor **native messaging** for the browser bridge. Chrome starts a separately installed host and exchanges framed JSON through stdin/stdout; the manifest allowlists exact extension origins. It requires `nativeMessaging`, an installed executable, and OS-specific registration—Windows registry entries versus macOS/Linux manifest paths. Validate extension/content-script messages before forwarding. This removes a listening HTTP port but adds installer and stable extension-ID work. [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

A localhost bridge is a possible development alternative. Declare the exact loopback host permission. Design requirements: bind only to loopback, authenticate every request with a paired secret, validate Host/Origin, reject arbitrary origins and unauthenticated mutation, prevent replay, and restrict operations to the same action schema. CORS is not authentication. Add startup, port-conflict, browser-policy, and reconnection tests before promising friend-friendly setup. [Chrome host patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns), [Network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

Do not advertise universal harness support. Initially support one verified adapter with structured input/output, cancellation, deadlines, capability checks, and version detection. A Markdown skill does not guarantee that every harness supports its tools, scheduling, filesystem behavior, or authentication. Subscription eligibility and unattended use need provider-specific validation. Local execution stops when the user's machine/runtime is unavailable; preserving computer-off operation still requires some hosted runtime. Downloading local scripts does not authorize executing them inside the extension.

## Acceptance gates worth prioritizing

1. Replay a command/event: no duplicated completed side effects or status mutation.
2. Kill the worker after each checkpoint, including the tab-created/journal-missing gap: recover or show an explicit partial state.
3. Restart Chrome with restored tabs: no stale-ID mutation; task manifest remains available.
4. Sleep/offline/reconnect: hosted preparation persists; no surprise flood of tabs.
5. Navigate during capture, deny access, or encounter iframe content: show preview/fallback, never silently save the wrong job.
6. Pair two users/devices, revoke one, replay expired tokens: no cross-user access or further authorized commands.
7. Feed malicious job text, unknown actions, privileged URLs, and oversized messages: reject safely; page text never becomes executable instructions.
8. Close a tab or visit a confirmation-looking page: application remains unchanged until explicit completion.
9. Local option only: missing companion, wrong extension ID, stale adapter, revoked provider credential, hostile localhost request, and sleeping laptop produce clear recoverable states.

This is sourced design research, not an implemented or browser-tested extension.
