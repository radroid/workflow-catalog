/**
 * The exact install commands, in one place so later packets update a single
 * module instead of hunting through JSX. Spec F3 / P09-catalog-site.md part
 * A; P09.1 (P09-B review round 2 + P02 review round 1 follow-ups) resynced
 * this to the runner P02 actually shipped.
 */
export interface InstallStep {
  id: string;
  label: string;
  commands?: string[];
  note?: string;
}

export const INSTALL_STEPS: InstallStep[] = [
  {
    id: "get-runner",
    label: "Get the runner",
    // P09.1: the runner now installs only from a whole-repo clone — its
    // workspace:* dependencies on @workflow-catalog/contracts and the eve
    // adapter only resolve inside a pnpm workspace, which a degit-style
    // partial fetch of runner/ alone can never provide (runner/README.md,
    // "Install": "Why not npx degit ... plus npm install"). Copied verbatim
    // from that same fenced block, corepack's inline comment aside — see
    // tests/install-guide-drift.test.ts, which fails if this ever drifts
    // from it again.
    commands: [
      "git clone https://github.com/radroid/workflow-catalog.git",
      "cd workflow-catalog",
      "corepack enable",
      "pnpm install --frozen-lockfile",
      "cd runner",
    ],
  },
  {
    id: "setup",
    label: "Run setup",
    commands: ["npm run setup"],
    note: "Connects your provider (ChatGPT or an API key) and chooses where your workspace lives. ChatGPT mode needs the Codex CLI signed in first (codex login) — Codex owns that sign-in, and the runner never stores a ChatGPT credential itself.",
  },
  {
    id: "doctor",
    label: "Check readiness",
    commands: ["npm run doctor"],
    note: "Prints the same five checks as the checklist below.",
  },
  {
    id: "start",
    label: "Start the runner",
    commands: ["npm run runner"],
  },
  {
    id: "extension",
    label: "Load the Chrome extension",
    commands: ["pnpm --filter @workflow-catalog/extension build"],
    note: "Until the private Web Store listing exists, load it unpacked: open chrome://extensions, enable Developer mode, choose “Load unpacked,” and select extension/dist — the whole-repo clone above already put it on your machine.",
  },
];
