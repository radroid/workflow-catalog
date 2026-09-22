/**
 * The exact install commands, in one place so later packets update a single
 * module instead of hunting through JSX. Spec F3 / P09-catalog-site.md part
 * A; P09.1 (P09-B review round 2 + P02 review round 1 follow-ups, then its
 * own revision round) resynced this to the runner P02 actually shipped.
 */
export interface InstallPrereq {
  text: string;
  /** A prerequisite that itself needs a command run (e.g. installing the Codex CLI), not just a fact to check. */
  commands?: string[];
  /** A caption shown just above `commands` (outside the copyable block) when they apply only sometimes. */
  commandsLabel?: string;
}

export interface InstallStep {
  id: string;
  label: string;
  commands?: string[];
  /** A caption shown just above `commands` (outside the copyable block): where or when to run them. */
  commandsLabel?: string;
  note?: string;
  /** "Before you start": distinct prerequisite bullets, not one run-on paragraph — see InstallPrereq. */
  prereqs?: InstallPrereq[];
  /**
   * True when this step's `commands` are copied verbatim, in order, from
   * runner/README.md's "## Install" fenced code block — the exact set
   * tests/install-guide-drift.test.ts concatenates (in INSTALL_STEPS' own
   * array order) and compares against that block. Building/loading the
   * extension, pairing, doctor, and the prerequisites are real steps here
   * but aren't part of that particular snippet, so they leave this unset.
   */
  inRunnerReadmeInstall?: boolean;
}

/**
 * `command` split just after each "/" in a URL's path, so a narrow screen
 * can wrap the clone URL between path segments (after "github.com/" or
 * "radroid/") instead of mid-word. The install page puts a <wbr> between
 * the parts. A <wbr> adds no character, so the parts always
 * join back to exactly `command`, and copying a block still copies exactly
 * its commands (tests/install-command-block.test.ts).
 */
export function urlBreakParts(command: string): string[] {
  return command.split(/(?<=https:\/\/\S*\/)(?=[^\s/])/);
}

export const INSTALL_STEPS: InstallStep[] = [
  {
    id: "before-you-start",
    label: "Before you start",
    prereqs: [
      {
        // Matches runner/README.md's own sentence verbatim (P02.1 landed
        // the same line there, on overnight/integration at d9454f2) — see
        // tests/install-guide-drift.test.ts's prerequisite-wording check.
        text: "Node 24 is the tested version and ships with Corepack. On Node 25 or newer, run npm install -g corepack first.",
        commandsLabel: "Node 25 or newer only:",
        commands: ["npm install -g corepack"],
      },
      {
        text: "git, and a Chromium-based browser (Google Chrome or similar) for the extension.",
      },
      {
        // No "# or: brew install codex" line in the block: zsh (macOS's
        // default shell) runs a pasted "#" line as a command, since its
        // interactive_comments option is off by default. The alternative
        // lives in the sentence instead.
        text: "For ChatGPT mode: the Codex CLI, installed and signed in. Using an API key instead? Skip this. With Homebrew, brew install codex works in place of the npm line.",
        commands: ["npm install -g @openai/codex", "codex login"],
      },
    ],
  },
  {
    id: "get-the-code",
    label: "Get the code",
    // The runner installs only from a whole-repo clone — its workspace:*
    // dependencies on @workflow-catalog/contracts and the eve adapter only
    // resolve inside a pnpm workspace (runner/README.md, "Install": "Why
    // not npx degit ... plus npm install"). Copied verbatim from that same
    // fenced block, corepack's inline comment aside — see
    // tests/install-guide-drift.test.ts, which fails if this ever drifts
    // from it again.
    inRunnerReadmeInstall: true,
    commands: [
      "git clone https://github.com/radroid/workflow-catalog.git",
      "cd workflow-catalog",
      "corepack enable",
      "pnpm install --frozen-lockfile",
    ],
  },
  {
    id: "build-extension",
    label: "Build the extension",
    commands: ["pnpm --filter @workflow-catalog/extension build"],
    note: "Run it anywhere inside the clone; outside it nothing builds.",
  },
  {
    id: "setup",
    label: "Set up",
    inRunnerReadmeInstall: true,
    commands: ["cd runner", "npm run setup"],
    note: "Connects your provider (ChatGPT or an API key) and chooses where your workspace lives.",
  },
  {
    id: "start",
    label: "Start the runner",
    inRunnerReadmeInstall: true,
    commands: ["npm run runner"],
    note: "Keeps this terminal busy — leave it running, and open a second terminal for the next steps.",
  },
  {
    id: "load-extension",
    label: "Load the extension",
    note: "Until the private Web Store listing exists, load it unpacked: open chrome://extensions, enable Developer mode, choose “Load unpacked,” and select workflow-catalog/extension/dist, which the build just created.",
  },
  {
    id: "pair",
    label: "Pair the extension",
    commandsLabel: "In a second terminal, in workflow-catalog/runner:",
    commands: ["npm run pair"],
    note: "Prints a fresh code — good for 10 minutes, works once. Enter it on the extension's options page: right-click the extension's icon, then Options.",
  },
  {
    id: "doctor",
    label: "Check readiness",
    commands: ["npm run doctor"],
    // Quotes runner/lib/doctor.ts's own output (formatDoctorReport's marks
    // and closing line; providerItem's detail and fix). See
    // tests/install-guide-drift.test.ts, which checks each quote there.
    note: "Doctor prints its seven checks — the five below, plus the privacy switches and the eve pin — each marked [ok], [warn] or [FAIL], and ends with “All required checks pass.” when none is [FAIL]. On a first install, “Provider connected” stays [warn] (“the model has not been verified yet”) until one npm run doctor -- --live, which makes one short model call, or “Check the model” on the runner's status page.",
  },
];
