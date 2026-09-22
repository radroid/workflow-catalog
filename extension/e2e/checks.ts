/**
 * Page checks shared by the e2e specs. The axe audit and `waitForDownload`
 * moved here from real-popup.spec.ts (P07-B revision 2, D) so
 * bridge-e2e.spec.ts can run the same audit on the popup and options
 * states it drives against the real bridge, in both themes, and check the
 * options page's own export download. Every check takes an `evaluate`
 * function, so it works on a raw-CDP popup and a Playwright page alike.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect } from "./fixtures";
import { sleep } from "./real-popup-cdp";

type Evaluate = (expression: string) => Promise<unknown>;

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
// Same tag set as WCAG A/AA + best-practice; violations only (not
// "incomplete" -- those need a human judgment call axe can't make itself,
// and asserting on them would make this test flaky against axe's own
// heuristics, not this extension's markup).
const AXE_RUN_EXPRESSION = `
  axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    resultTypes: ["violations"],
  }).then((results) => results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
  })))
`;

interface AxeViolationSummary {
  id: string;
  impact: string | null;
  nodes: number;
  targets: string[];
}

export async function assertNoAxeViolations(evaluate: Evaluate, label: string): Promise<void> {
  await evaluate(AXE_SOURCE);
  const violations = (await evaluate(AXE_RUN_EXPRESSION)) as AxeViolationSummary[];
  expect(violations, `axe violations on ${label}:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

export async function waitForDownload(dir: string, filename: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const target = path.join(dir, filename);
  while (Date.now() < deadline) {
    if (existsSync(target)) {
      const content = readFileSync(target, "utf8");
      if (content.length > 0) return content;
    }
    await sleep(100);
  }
  throw new Error(`${filename} never appeared in ${dir} (present: ${readdirSync(dir).join(", ") || "(empty)"})`);
}

/**
 * P07-B revision 2, D: every element with the `hidden` attribute really is
 * `display: none` -- what base.css's `[hidden]{display:none !important}`
 * is for (P07-B revision 1). Without it, an author `display` on the same
 * element (`.stack`, `.row`) beats the UA stylesheet's `[hidden]` rule and
 * the element shows. A unit test can't see this (happy-dom only has the
 * property); a real browser's computed style can. The options page always
 * has such an element hidden: the Un-pair row while unpaired, the code
 * form while paired.
 */
const HIDDEN_BUT_DISPLAYED = `Array.from(document.querySelectorAll("[hidden]"))
  .filter((element) => getComputedStyle(element).display !== "none")
  .map((element) => element.outerHTML.slice(0, 160))`;

export async function expectHiddenReallyHidden(evaluate: Evaluate, label: string): Promise<void> {
  const offenders = (await evaluate(HIDDEN_BUT_DISPLAYED)) as string[];
  expect(offenders, `${label}: elements with the hidden attribute that still display`).toEqual([]);
}

/**
 * P07-B revision 2, C1: an empty message area (a `.flash` or live region
 * waiting for its first message) takes no space and draws nothing, but
 * stays in the page -- never `display: none`, which would drop the live
 * region from the accessibility tree. Revision 1 drew each one as a 16px
 * amber-edged bar.
 */
const EMPTY_REGIONS_MISBEHAVING = `Array.from(document.querySelectorAll('.flash, [role="status"], [role="alert"], [aria-live]'))
  .filter((element) => element.childNodes.length === 0 && !element.closest("[hidden]"))
  .map((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return { html: element.outerHTML.slice(0, 160), display: style.display, height: box.height, borderLeft: style.borderLeftWidth };
  })
  .filter((found) => found.display === "none" || found.height > 0 || found.borderLeft !== "0px")`;

export async function expectEmptyRegionsCollapsed(evaluate: Evaluate, label: string): Promise<void> {
  const offenders = (await evaluate(EMPTY_REGIONS_MISBEHAVING)) as unknown[];
  expect(offenders, `${label}: empty message areas that take space, draw a border, or left the page`).toEqual([]);
}
