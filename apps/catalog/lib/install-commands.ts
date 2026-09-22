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
    commands: ["npx degit radroid/workflow-catalog/runner runner", "# or, if you prefer a full clone:", "git clone https://github.com/radroid/workflow-catalog.git"],
  },
  {
    id: "install",
    label: "Install dependencies",
    commands: ["cd runner", "npm install"],
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
    note: "Until the private Web Store listing exists: open chrome://extensions, enable Developer mode, choose “Load unpacked,” and select the extension/ directory from your clone.",
  },
];
