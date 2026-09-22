import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALL_STEPS, urlBreakParts } from "../lib/install-commands";

// P09.1 revision round (UI critic U2): commands must be selectable and
// copyable exactly as written — no "$ " prompt or other decoration is ever
// added to the DOM; only a CSS hanging indent (globals.css's .command-line,
// see tests/globals.test.ts) gives a wrapped continuation a *visual*
// distinction from a new command. This repo's established convention is
// reading source as text and asserting structural facts rather than
// rendering a Server Component (README.md's Tests section) —
// CommandBlock is a helper inside an async Server Component (InstallPage),
// which can't be meaningfully rendered in isolation, and happy-dom (this
// repo's only DOM test environment) has no real selection/clipboard engine
// to verify copy behavior against even if it could be. A live Playwright
// check (select all inside a rendered command block, copy, compare against
// the exact command text) supplements this structurally during the
// packet's acceptance screenshots; see the P09.1 report.

const here = path.dirname(fileURLToPath(import.meta.url));
const installPageSource = readFileSync(path.join(here, "../app/(gated)/install/page.tsx"), "utf8");
const globalsCss = readFileSync(path.join(here, "../app/globals.css"), "utf8");

function extractFunctionSource(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`expected to find ${JSON.stringify(signature)}`);
  const end = source.indexOf(nextSignature, start);
  if (end === -1) throw new Error(`expected ${JSON.stringify(nextSignature)} to follow ${JSON.stringify(signature)}`);
  return source.slice(start, end);
}

const commandBlockSource = extractFunctionSource(installPageSource, "function CommandBlock(", "export default async function InstallPage");

const allCommands = INSTALL_STEPS.flatMap((step) => [
  ...(step.commands ?? []),
  ...(step.prereqs ?? []).flatMap((prereq) => prereq.commands ?? []),
]);

describe("install command blocks copy exactly their commands (P09.1 revision round, UI critic U2)", () => {
  it("<pre className=\"command-block\"> contains nothing but the commands.map(...) call — no separator/joiner between commands", () => {
    // Anchoring the whole <pre>...</pre> body to this one shape rules out
    // anything else being interleaved between mapped commands (a literal
    // "\n" join, a <br/>, a separator span) — the only children the
    // rendered <pre> can ever have are the .command-line elements the map
    // produces, back to back.
    //
    // P09.1 revision 2 (UI critic, <wbr> in the clone URL): inside each
    // .command-line, the command's urlBreakParts are rendered back to back
    // with nothing between them but a <wbr />, which is a break
    // opportunity, not a character. The test below proves the parts join
    // back to exactly the command.
    expect(commandBlockSource).toMatch(
      /<pre className="command-block">\s*\{commands\.map\(\(command, index\) => \(\s*<code className="command-line" key=\{index\}>\s*\{urlBreakParts\(command\)\.map\(\(part, partIndex\) => \(\s*<Fragment key=\{partIndex\}>\s*\{partIndex > 0 \? <wbr \/> : null\}\s*\{part\}\s*<\/Fragment>\s*\)\)\}\s*<\/code>\s*\)\)\}\s*<\/pre>/,
    );
  });

  it("never concatenates a prompt string (\"$ \", \"> \", or similar) onto a command inside CommandBlock", () => {
    // Scoped to CommandBlock's own function body, not the whole file — the
    // file's doc comment above it *discusses* "$ " in prose (explaining
    // this very guarantee), which would otherwise false-positive a
    // whole-file text match. Revision 2: each command now renders as its
    // urlBreakParts, so `part` is guarded the same way as `command`.
    expect(commandBlockSource).not.toMatch(/["'`]\$ ["'`]/);
    expect(commandBlockSource).not.toMatch(/["'`]>\s?["'`]\s*\+\s*(?:command|part)/);
    expect(commandBlockSource).not.toMatch(/\{(?:command|part)\}\s*\+/); // "{command} + " would mean something is appended after it
    expect(commandBlockSource).not.toMatch(/\+\s*\{?(?:command|part)\}?\s*\}/); // catches `{"$ " + command}`-style interpolation too
  });

  it("every command's urlBreakParts join back to exactly the command, so a <wbr> between them changes nothing a copy produces", () => {
    expect(allCommands.length).toBeGreaterThan(0);
    for (const command of allCommands) {
      expect(urlBreakParts(command).join("")).toBe(command);
    }
  });

  it("the clone URL can wrap after github.com/ and radroid/, not mid-word; a command without a URL is one part", () => {
    expect(urlBreakParts("git clone https://github.com/radroid/workflow-catalog.git")).toEqual([
      "git clone https://github.com/",
      "radroid/",
      "workflow-catalog.git",
    ]);
    // Not a URL: a package scope's "/" gets no break opportunity.
    expect(urlBreakParts("pnpm --filter @workflow-catalog/extension build")).toEqual([
      "pnpm --filter @workflow-catalog/extension build",
    ]);
  });

  it("no command is, or carries, a shell comment — zsh runs a pasted \"#\" line as a command", () => {
    // P09.1 revision 2 (UI critic): the Codex block had a "# or: brew install
    // codex" line. zsh, macOS's default shell, leaves interactive_comments
    // off, so pasting that line runs "#" as a command, and an inline
    // "# ..." after a command is passed to it as arguments.
    for (const command of allCommands) {
      expect(command).not.toMatch(/(^|\s)#/);
    }
  });

  it("no command string in INSTALL_STEPS itself carries a leading shell-prompt character", () => {
    // Belt-and-suspenders with the component-level checks above: even if
    // CommandBlock's own rendering were perfectly bare, a prompt baked into
    // the data itself would still show up in a copy.
    expect(allCommands.length).toBeGreaterThan(0);
    for (const command of allCommands) {
      expect(command).not.toMatch(/^\s*[$>]\s/);
    }
  });

  it("globals.css injects no generated content on .command-line or pre.command-block (a ::before prompt would defeat the same guarantee visually)", () => {
    expect(globalsCss).not.toMatch(/\.command-(?:line|block)[^{]*::(?:before|after)/);
  });
});
