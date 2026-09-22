import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_STEPS } from "../lib/install-commands";
import { INSTALL_CHECKLIST_ITEMS } from "../lib/install-status";

// P09.1 (P09-B review round 2 + P02 review round 1 follow-ups): the catalog's
// install guide used to describe a degit-only install ("npx degit
// .../runner" + "npm install") that P02's actual runner can't use — its
// workspace:* dependencies only resolve inside a pnpm workspace. This file
// reads runner/README.md, extension/README.md and runner/package.json — the
// source of truth for the real install commands and scripts (CLAUDE.md:
// "Copy them; don't invent") — and fails if apps/catalog/lib/install-commands.ts
// or lib/install-status.ts ever drifts from them again, the way it did once
// already.
//
// P09.1 revision round (reviewer R2): the first version of this file only
// compared a hand-picked slice of commands, never checked step *order*,
// checklist *labels*, or npm-script existence — a reviewer mutation that
// reordered steps, typo'd a script name, and reworded a checklist item all
// stayed green through it. This version fixes that: INSTALL_STEPS' own
// `inRunnerReadmeInstall` flag (not hardcoded ids) selects and orders the
// README-block comparison, an explicit id-order array is asserted, every
// `npm run <script>` is checked against runner/package.json's real scripts,
// and doctor's checklist labels are read out of runner/lib/doctor.ts's own
// source rather than assumed.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../../..");
const runnerReadme = readFileSync(path.join(repoRoot, "runner/README.md"), "utf8");
const extensionReadme = readFileSync(path.join(repoRoot, "extension/README.md"), "utf8");
const runnerPackageJson = JSON.parse(readFileSync(path.join(repoRoot, "runner/package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const doctorTs = readFileSync(path.join(repoRoot, "runner/lib/doctor.ts"), "utf8");

/**
 * The raw text from `startHeading` (which must appear exactly once) up to
 * the next Markdown heading line after it, or the end of the file if none
 * follows. R2 (low #2): a hardcoded end-heading string threw if that
 * heading was ever renamed, even when nothing about the *section being
 * tested* had drifted at all — slicing to "whatever heading comes next"
 * survives a rename on either side of the section this file actually cares
 * about.
 */
function sectionToNextHeading(markdown: string, startHeading: string): string {
  const start = markdown.indexOf(startHeading);
  if (start === -1) throw new Error(`expected to find heading ${JSON.stringify(startHeading)}`);
  const searchFrom = start + startHeading.length;
  const rest = markdown.slice(searchFrom);
  const nextHeading = /\n#{1,6} /.exec(rest);
  const end = nextHeading ? searchFrom + nextHeading.index : markdown.length;
  return markdown.slice(start, end);
}

/** The first ```sh ... ``` fenced block within a section. */
function fencedShBlock(section: string): string {
  const body = /```sh\n([\s\S]*?)```/.exec(section)?.[1];
  if (body === undefined) throw new Error("expected a ```sh code block in this section");
  return body;
}

/**
 * Strips a trailing "# ..." inline comment (e.g. runner/README.md's
 * "corepack enable          # provides the pinned pnpm") and surrounding
 * whitespace — the comment is prose about the command, not part of what a
 * person actually types, so INSTALL_STEPS carries the bare command and
 * explains the "why" via its own `note` field instead of replicating
 * arbitrary comment spacing byte-for-byte.
 */
function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return (hashIndex === -1 ? line : line.slice(0, hashIndex)).trim();
}

function commandLines(fencedBlock: string): string[] {
  return fencedBlock
    .split("\n")
    .map(stripInlineComment)
    .filter((line) => line.length > 0);
}

/** Collapses whitespace/newlines to single spaces and drops backticks, so a two-line Markdown paragraph compares equal to INSTALL_STEPS' own one-line prereq text. */
function normalizeProse(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

/**
 * doctor.ts's seven checklist items each construct `const label = "...";`
 * (six of them) or `` const label = `eve pinned to ${EVE_PIN}`; `` (the
 * seventh — a template literal, since its text is dynamic). Matching either
 * quote style, in source order, gives the same order `runDoctor()` pushes
 * them into `items` (confirmed by reading both: nodeItem, runnerItem,
 * providerItem, workspaceItem, extensionItem, privacyItem, eveItem, in that
 * order in both places).
 */
function extractDoctorLabels(source: string): string[] {
  const matches = [...source.matchAll(/const label = (`[^`]*`|"[^"]*");/g)];
  return matches.map((m) => m[1]!.slice(1, -1));
}

describe("install guide — synced to runner/README.md, extension/README.md and runner/package.json (P09.1)", () => {
  it("has exactly the expected steps, in this exact order", () => {
    // R2: a reviewer mutation reordered steps and 154/154 tests stayed
    // green because nothing ever asserted order on its own — only on the
    // README-block subset below. This is the literal, human-reviewable
    // expectation for the whole guide, README-tested or not.
    expect(INSTALL_STEPS.map((step) => step.id)).toEqual([
      "before-you-start",
      "get-the-code",
      "build-extension",
      "setup",
      "start",
      "load-extension",
      "pair",
      "doctor",
    ]);
  });

  it("the get-the-code → setup → start commands match runner/README.md's Install code block, in order", () => {
    const readmeCommands = commandLines(fencedShBlock(sectionToNextHeading(runnerReadme, "## Install")));

    // inRunnerReadmeInstall (not a hardcoded id list) picks the subset that
    // is supposed to equal this fenced block, in INSTALL_STEPS' own array
    // order — so reordering INSTALL_STEPS itself reorders this comparison
    // too, instead of silently comparing against a list frozen at the time
    // this test was written.
    const flattened = INSTALL_STEPS.filter((step) => step.inRunnerReadmeInstall).flatMap((step) => step.commands ?? []);

    expect(flattened).toEqual(readmeCommands);
  });

  it("never reintroduces the degit path runner/README.md dropped", () => {
    for (const step of INSTALL_STEPS) {
      for (const command of step.commands ?? []) {
        expect(command).not.toMatch(/degit/);
      }
    }
  });

  it("the before-you-start Node/Corepack prerequisite matches runner/README.md's own sentence", () => {
    // Anchored on the sentence's own stable opening/closing words rather
    // than the surrounding heading structure, since it is prose inside the
    // Install section, not its own subsection.
    const installSection = sectionToNextHeading(runnerReadme, "## Install");
    const readmeSentence = /Node 24 is the tested version[\s\S]*?first\./.exec(installSection)?.[0];
    expect(readmeSentence, "expected the Node/Corepack sentence in runner/README.md's Install section").toBeDefined();

    const beforeYouStart = INSTALL_STEPS.find((step) => step.id === "before-you-start");
    const nodePrereq = beforeYouStart?.prereqs?.find((prereq) => prereq.text.includes("Node 24"));

    expect(nodePrereq?.text).toBe(normalizeProse(readmeSentence!));
  });

  it("the build-extension step's command matches extension/README.md's Build section", () => {
    const buildCommands = commandLines(fencedShBlock(sectionToNextHeading(extensionReadme, "## Build")));
    const buildStep = INSTALL_STEPS.find((step) => step.id === "build-extension");
    expect(buildStep?.commands).toEqual(buildCommands);
  });

  it("the load-extension step names the same unpacked folder as extension/README.md's Load unpacked section", () => {
    const loadUnpackedSection = sectionToNextHeading(extensionReadme, "## Load unpacked");
    expect(loadUnpackedSection).toMatch(/extension\/dist/);

    const loadExtensionStep = INSTALL_STEPS.find((step) => step.id === "load-extension");
    expect(loadExtensionStep?.note).toMatch(/extension\/dist/);
    expect(loadExtensionStep?.note).toMatch(/Developer mode/);
    expect(loadExtensionStep?.note).toMatch(/Load unpacked/);
  });

  it("every `npm run <script>` in the guide is a real script in runner/package.json", () => {
    const referencedScripts = new Set<string>();
    for (const step of INSTALL_STEPS) {
      for (const command of step.commands ?? []) {
        const match = /^npm run (\S+)/.exec(command);
        if (match) referencedScripts.add(match[1]!);
      }
    }

    // Both a precise expected set (catches a typo'd script name, e.g. R2's
    // "doctr" example, as a set mismatch) and a per-script existence check
    // against the real package.json (catches the same typo as a missing
    // property, so either assertion alone would already fail it).
    expect([...referencedScripts].sort()).toEqual(["doctor", "pair", "runner", "setup"]);
    for (const script of referencedScripts) {
      expect(runnerPackageJson.scripts).toHaveProperty(script);
    }
  });

  it("the checklist item ids and labels match doctor's first five, in order", () => {
    const doctorLabels = extractDoctorLabels(doctorTs);
    expect(doctorLabels.length).toBe(7);

    expect(INSTALL_CHECKLIST_ITEMS.map((item) => item.id)).toEqual(["node", "runner", "provider", "workspace", "extension"]);
    expect(INSTALL_CHECKLIST_ITEMS.map((item) => item.label)).toEqual(doctorLabels.slice(0, 5));
  });

  it("the doctor step's note accurately describes all seven checks, and doctor runs last", () => {
    // R3 / UI critic U5: the note used to describe doctor's five items as
    // if that were the whole picture, and doctor used to run mid-guide —
    // both stale once the guide restructured. doctorLabels[5]/[6] are
    // "Privacy settings" and the (templated) eve-pin label; see
    // extractDoctorLabels' doc comment for why the eve one is checked as a
    // prefix rather than an exact string.
    const doctorLabels = extractDoctorLabels(doctorTs);
    expect(doctorLabels[5]).toBe("Privacy settings");
    expect(doctorLabels[6]).toMatch(/^eve pinned to /);

    const doctorStep = INSTALL_STEPS.find((step) => step.id === "doctor");
    expect(doctorStep?.note).toMatch(/seven/i);
    expect(doctorStep?.note).toMatch(/privacy/i);
    expect(doctorStep?.note).toMatch(/eve pin/i);

    expect(INSTALL_STEPS.at(-1)?.id).toBe("doctor");
  });
});
