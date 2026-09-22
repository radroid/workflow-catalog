import type { BrowserPermission, SourceCategory, WorkflowConnection } from "@workflow-catalog/contracts";

/**
 * Plain-language copy for the template page (P09-catalog-site.md part B:
 * "the seven required sources in plain language ... the six browser
 * permissions, each explained in one line"). Written as `Record<Union,
 * string>` — an exhaustive mapped type, not built programmatically — so
 * that if contracts ever adds or removes a source category, connection, or
 * permission, this file fails to typecheck until the copy here is updated
 * too. Same defensive-completeness style as sourceSchema in
 * packages/contracts/src/source.ts.
 */
export const SOURCE_CATEGORY_LABELS: Record<SourceCategory, string> = {
  resume: "Resume",
  previousCoverLetters: "Previous cover letters",
  portfolioSite: "Portfolio or personal site",
  repositories: "Code repositories",
  socialProfiles: "Social profile exports (e.g. LinkedIn's data export)",
  workSamples: "Work samples",
  targetRolesAndPreferences: "Target roles and preferences",
};

export const CONNECTION_LABELS: Record<WorkflowConnection, string> = {
  file_upload: "File upload (PDF, DOCX, Markdown, or plain text)",
  pasted_text: "Pasted text",
  url_import: "URL import (the runner fetches a public page)",
  github: "GitHub, read-only (a token you already have, or a fine-grained PAT you paste once)",
  social_export_files: "A social profile's exported data archive, uploaded as a file",
};

// mvp-spec.md §7.3 / CLAUDE.md's Hard rules: exactly these six, host
// permission only the bridge origin, never `tabs`/`debugger`/`<all_urls>`.
export const BROWSER_PERMISSION_DESCRIPTIONS: Record<BrowserPermission, string> = {
  activeTab: "See the page you're on only when you click the extension — never in the background.",
  scripting: "Read a job posting's text out of the tab you just captured it from.",
  tabGroups: "Group the tabs one application session opens, so they're easy to find and close together.",
  storage: "Remember pairing and extension settings on this device — never your career data.",
  sidePanel: "Show the current application's job, prepared documents, and remaining steps beside the page.",
  alarms: "Check in with your local runner on a schedule, even after the background worker goes to sleep.",
};
