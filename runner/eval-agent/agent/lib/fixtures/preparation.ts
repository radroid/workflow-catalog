import type { MockModelRequest, MockModelResponse } from "eve/evals";
import { PREPARATION_PROMPT_FIRST_LINE } from "../../../../agent/lib/prepare-prompt.ts";
import type { FixtureHandler } from "../fixture-registry.ts";

/**
 * P05's scripted-model branch: a preparation turn, driven by the real prompt
 * `buildPreparationPrompt` writes (recognised by its fixed first line), not
 * by a fixture phrase. It reads the taskId, the confirmed claims and the
 * numbered requirements out of the prompt's data block the way a model
 * would, then plays one well-behaved preparation:
 *
 * 1. loads the skills the prompt names;
 * 2. accounts for every requirement: covered by the confirmed claims that
 *    meet it (by the table below), a gap with a question where none does,
 *    left out where the person's answers say so, and set aside when the line
 *    is not a requirement at all (the hostile posting's injected line);
 * 3. with any gap, sends only the requirements and stops;
 * 4. otherwise drafts, first with one deliberately wrong number, so the
 *    tool refuses it, then again without it (the revision pass);
 * 5. ends with one line reporting what it saw, for the eval to check: the
 *    tool's answers, whether any system message carried the posting's
 *    words, whether the instruction lines did, and whether the excluded
 *    metric appeared anywhere in the conversation.
 *
 * Fixture text is duplicated by value here (as in `./onboarding.ts`):
 * bundled agent code can't read the package's fixture files at run time.
 * `evals/preparation.eval.ts` checks it against those files.
 */

/** Which confirmed claims (by the fixture's labels) meet each requirement a fixture posting lists. */
export const PREPARATION_COVERAGE: Readonly<Record<string, readonly string[]>> = {
  "Experience leading platform or infrastructure teams": ["C1", "C8"],
  "Experience with deployment pipeline design": ["C4"],
  "Comfortable working directly with internal customers": ["C3"],
};

/** The question the fixture model asks for a requirement no confirmed claim meets. */
export const PREPARATION_QUESTIONS: Readonly<Record<string, string>> = {
  "8+ years of backend engineering experience": "How many years of backend engineering experience can you show?",
  "Strong distributed systems fundamentals": "Which of your work shows distributed systems experience?",
  "3+ years of experience with CI/CD systems": "Which CI/CD systems have you worked with, and for how long?",
  "Experience with deployment pipeline design": "Which deployment pipelines have you designed?",
  "4+ years of experience": "How many years of professional experience can you show?",
  "Node.js and TypeScript": "Which of your work used Node.js or TypeScript?",
};

const DEFAULT_QUESTION = "What in your experience meets this requirement?";

/** A line a posting presents as a requirement that is really an instruction to the reader: set aside, never acted on. */
const NOT_A_REQUIREMENT = /ignore previous instructions|^SYSTEM:/i;

/** The excluded metric's words (expected-excluded-metric.json): they must never be anywhere in the conversation. */
export const EXCLUDED_METRIC_WORDS = "Grew signups 500%";

/** The deliberately wrong sentence of the first draft: "8" is in no claim, so the tool refuses it. */
export const WRONG_NUMBER_SENTENCE = "Led a platform team of 8 engineers at Northwind Labs [C1].";

/** The fixture draft: each sentence states only what its cited claims say (expected-claims.json, labels by position). */
export const PREPARATION_RESUME: ReadonlyArray<{ readonly heading: string; readonly statements: readonly string[] }> = [
  { heading: "Summary", statements: ["Senior Platform Engineer at Northwind Labs since 2022 [C8][C7]."] },
  {
    heading: "Experience",
    statements: [
      "Led the payments infrastructure team at Northwind Labs, redesigning the ledger service behind its billing [C1].",
      "Shipped the on-call rotation tooling used by three engineering teams [C3].",
    ],
  },
  { heading: "Open source", statements: ["Maintainer of Ledgerkit, an open-source ledger reconciliation library [C5]."] },
  { heading: "Education", statements: ["B.S. Computer Science, Fernwood University, 2019 [C6]."] },
];

export const PREPARATION_LETTER: ReadonlyArray<readonly string[]> = [
  ["At Northwind Labs I led the payments infrastructure team and redesigned the ledger service behind its billing [C1].", "I also shipped on-call rotation tooling used by three engineering teams [C3]."],
  ["Outside work, I maintain Ledgerkit, an open-source ledger reconciliation library [C5]."],
];

interface ReadPrompt {
  readonly taskId: string;
  readonly instructions: string;
  readonly labels: ReadonlySet<string>;
  readonly requirements: readonly string[];
  readonly leaveOut: ReadonlySet<number>;
  readonly coverLetter: boolean;
}

function readPrompt(prompt: string): ReadPrompt | undefined {
  const taskId = /taskId "([0-9a-f-]{36})"/.exec(prompt)?.[1];
  const start = /^--- (DATA-[A-Za-z0-9_-]+) START ---$/m.exec(prompt);
  if (!taskId || !start) return undefined;
  const end = prompt.indexOf(`--- ${start[1]} END ---`);
  const data = prompt.slice(start.index + start[0].length, end === -1 ? undefined : end).split("\n");
  const labels = new Set(data.flatMap((line) => /^\[(C\d+)\] /.exec(line)?.[1] ?? []));
  const from = data.indexOf("Requirements:");
  const to = data.findIndex((line) => line.startsWith("Nice to have"));
  const requirements = data.slice(from + 1, to === -1 ? undefined : to).flatMap((line) => /^\d+\. (.*)$/.exec(line)?.[1] ?? []);
  const leaveOut = new Set(data.flatMap((line) => /^- Requirement (\d+): leave it out\.$/.exec(line)?.[1] ?? []).map(Number));
  const instructions = prompt.slice(0, start.index);
  return { taskId, instructions, labels, requirements, leaveOut, coverLetter: instructions.includes("cover-letter-drafting") };
}

function citesOnly(statement: string, labels: ReadonlySet<string>): boolean {
  return [...statement.matchAll(/C\d+/g)].every((match) => labels.has(match[0]));
}

function requirementEntries(read: ReadPrompt) {
  return read.requirements.map((text, index) => {
    const requirement = index + 1;
    if (read.leaveOut.has(requirement)) return { requirement, status: "left_out" };
    if (NOT_A_REQUIREMENT.test(text)) return { requirement, status: "not_a_requirement" };
    const claims = (PREPARATION_COVERAGE[text] ?? []).filter((label) => read.labels.has(label));
    if (claims.length > 0) return { requirement, status: "covered", claims };
    return { requirement, status: "gap", question: PREPARATION_QUESTIONS[text] ?? DEFAULT_QUESTION };
  });
}

function draft(read: ReadPrompt, withWrongNumber: boolean) {
  const sections = PREPARATION_RESUME.map((section) => ({
    heading: section.heading,
    statements: [...(withWrongNumber && section.heading === "Experience" ? [WRONG_NUMBER_SENTENCE] : []), ...section.statements.filter((statement) => citesOnly(statement, read.labels))],
  })).filter((section) => section.statements.length > 0);
  const paragraphs = PREPARATION_LETTER.map((paragraph) => paragraph.filter((statement) => citesOnly(statement, read.labels))).filter((paragraph) => paragraph.length > 0);
  return { resume: { sections }, ...(read.coverLetter ? { coverLetter: { paragraphs } } : {}) };
}

/** What the fixture model saw, reported in its last line for the eval to check. */
function report(request: MockModelRequest, read: ReadPrompt): string {
  const statuses = request.toolResults.filter((result) => result.name === "prepare_application").map((result) => (result.output as { status?: string } | undefined)?.status ?? (result.isError ? "error" : "unknown"));
  const systemText = request.messages.filter((message) => message.role === "system").map((message) => message.text);
  const postingInSystem = read.requirements.some((requirement) => systemText.some((text) => text.includes(requirement)));
  const postingInInstructions = read.requirements.some((requirement) => read.instructions.includes(requirement));
  const excludedAnywhere = request.messages.some((message) => message.text.includes(EXCLUDED_METRIC_WORDS));
  return `preparation: ${JSON.stringify({ statuses, skillsLoaded: request.toolResults.filter((result) => result.name === "load_skill" && !result.isError).length, postingInSystem, postingInInstructions, excludedAnywhere })}`;
}

export const respond: FixtureHandler = (request: MockModelRequest, prompt: string): MockModelResponse | string | undefined => {
  if (!prompt.startsWith(PREPARATION_PROMPT_FIRST_LINE)) return undefined;
  const read = readPrompt(prompt);
  if (!read) return "preparation: the prompt had no task or data block";

  const skillResults = request.toolResults.filter((result) => result.name === "load_skill");
  const results = request.toolResults.filter((result) => result.name === "prepare_application");
  const requirements = requirementEntries(read);
  const gaps = requirements.some((entry) => entry.status === "gap");

  if (skillResults.length === 0) {
    const skills = ["claim-matching", ...(gaps ? [] : ["resume-drafting", ...(read.coverLetter ? ["cover-letter-drafting"] : [])])];
    return { toolCalls: skills.map((skill) => ({ name: "load_skill", input: { skill: `jobs__${skill}` } })) };
  }
  if (results.length === 0) {
    const input = gaps ? { taskId: read.taskId, requirements } : { taskId: read.taskId, requirements, ...draft(read, true) };
    return { toolCalls: [{ name: "prepare_application", input }] };
  }
  const last = results.at(-1)!.output as { status?: string } | undefined;
  if (results.length === 1 && last?.status === "refused" && !gaps) {
    return { toolCalls: [{ name: "prepare_application", input: { taskId: read.taskId, requirements, ...draft(read, false) } }] };
  }
  return report(request, read);
};
