# @workflow-catalog/extension

Placeholder. Becomes the Chrome MV3 extension (`manifest.json`, `worker.ts`,
`sidepanel/`, `capture/`, `pairing/`). Permissions are exactly `activeTab,
scripting, tabGroups, storage, sidePanel, alarms`; host permission only the
bridge origin — no `tabs`, `debugger`, `<all_urls>`, remote code, or eval
(`CLAUDE.md` hard rules). Filled in by packet **P07** (extension).
