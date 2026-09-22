/**
 * The exact install commands, in one place so later packets (P02 finalizes
 * them) update a single module instead of hunting through JSX. Spec F3 /
 * P09-catalog-site.md part A.
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
    // Each clone method is paired with its own correct `cd` right where it
    // happens — a shared later "cd runner" step was wrong for the full
    // clone (which creates workflow-catalog/, not runner/) and, per the
    // full-clone-only extension step below, also left no way to find
    // extension/ from the degit path.
    commands: [
      "npx degit radroid/workflow-catalog/runner runner && cd runner",
      "# or, for the full clone (also gives you the extension/ directory locally):",
      "git clone https://github.com/radroid/workflow-catalog.git && cd workflow-catalog/runner",
    ],
  },
  {
    id: "install",
    label: "Install dependencies",
    commands: ["npm install"],
  },
  {
    id: "setup",
    label: "Run setup",
    commands: ["npm run setup"],
    note: "Connects your provider (ChatGPT or an API key) and chooses where your workspace lives.",
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
    commands: ["# only needed if you used degit above (runner only, no extension/ yet):", "npx degit radroid/workflow-catalog/extension extension"],
    note: "Until the private Web Store listing exists, load it unpacked: open chrome://extensions, enable Developer mode, choose “Load unpacked.” Used the full clone above? Select workflow-catalog/extension. Used degit? Run the command above first, then select that extension/ directory.",
  },
];
