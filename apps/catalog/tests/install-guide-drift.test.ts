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
// reads runner/README.md and extension/README.md — the source of truth for
// the real install commands (CLAUDE.md: "Copy them; don't invent") — and
// fails if apps/catalog/lib/install-commands.ts or lib/install-status.ts
// ever drifts from them again, the way it did once already.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../../..");
const runnerReadme = readFileSync(path.join(repoRoot, "runner/README.md"), "utf8");
const extensionReadme = readFileSync(path.join(repoRoot, "extension/README.md"), "utf8");

/**
 * The raw text strictly between two heading lines (both must appear exactly
 * once — confirmed true for every heading used below). Plain indexOf, not a
 * heading-aware regex: every heading passed in here is a unique, exact
 * substring of its file (grep -c on each is 1), so nothing fancier is
 * needed to slice out one section without spilling into the next.
 */
function sectionBetween(markdown: string, startHeading: string, endHeading: string): string {
  const start = markdown.indexOf(startHeading);
  if (start === -1) throw new Error(`expected to find heading ${JSON.stringify(startHeading)}`);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  if (end === -1) throw new Error(`expected to find heading ${JSON.stringify(endHeading)} after ${JSON.stringify(startHeading)}`);
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

describe("install guide — synced to runner/README.md and extension/README.md (P09.1)", () => {
  it("the clone → setup → start commands match runner/README.md's Install code block, in order", () => {
    const readmeCommands = commandLines(fencedShBlock(sectionBetween(runnerReadme, "## Install", "## Scripts")));

    const stepsById = new Map(INSTALL_STEPS.map((step) => [step.id, step]));
    // "doctor" is deliberately not part of this comparison: it is a real,
    // separate INSTALL_STEPS entry (see the next test) that mirrors the
    // Scripts table's `doctor` row, not a line inside the Install
    // section's own fenced clone-through-start block.
    const flattened = [
      ...(stepsById.get("get-runner")?.commands ?? []),
      ...(stepsById.get("setup")?.commands ?? []),
      ...(stepsById.get("start")?.commands ?? []),
    ];

    expect(flattened).toEqual(readmeCommands);
  });

  it("never reintroduces the degit path runner/README.md dropped", () => {
    for (const step of INSTALL_STEPS) {
      for (const command of step.commands ?? []) {
        expect(command).not.toMatch(/degit/);
      }
    }
  });

  it("the extension step's build command matches extension/README.md's Build section", () => {
    const buildCommands = commandLines(fencedShBlock(sectionBetween(extensionReadme, "## Build", "## Load unpacked")));
    const extensionStep = INSTALL_STEPS.find((step) => step.id === "extension");
    expect(extensionStep?.commands).toEqual(buildCommands);
  });

  it("the checklist item ids still match npm run doctor's five, in the order runner/README.md's Doctor section lists them", () => {
    const doctorSection = sectionBetween(runnerReadme, "### Doctor", "## The bridge");

    expect(INSTALL_CHECKLIST_ITEMS.map((item) => item.id)).toEqual([
      "node",
      "runner",
      "provider",
      "workspace",
      "extension",
    ]);
    for (const item of INSTALL_CHECKLIST_ITEMS) {
      expect(doctorSection).toMatch(new RegExp("`" + item.id + "`"));
    }
  });
});
