import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RUNNER_DIR } from "../lib/paths.ts";
import { SCHEDULES, SCHEDULES_PROMPT_DIR } from "../scheduler/config.ts";

// Gate fix round 1, B1: `eve build` fails if a `.md` sits under `runner/agent/schedules/` without a `cron`
// frontmatter line — eve discovers every `.md` there as its own markdown schedule (node_modules/eve/docs/
// schedules.mdx, "Markdown form") and, worse, a `cron` line would make eve fire it itself, outside
// `withRun`/the budget, which the design rules out. So this schedule's own prompt files moved to
// `runner/scheduler/prompts/`, which eve never scans. This test guards the move: it fails loudly, with a
// clear reason, if anyone ever drops a `.md` back under `runner/agent/schedules/` without `cron`
// frontmatter — the exact regression B1 was.
const EVE_SCHEDULES_DIR = path.join(RUNNER_DIR, "agent", "schedules");

async function markdownFilesIn(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent entirely is fine — that's the whole point of the move
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
}

function hasCronFrontmatter(content: string): boolean {
  // eve's own markdown form: frontmatter opens with `---`, a `cron:` line appears before the closing `---`.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^cron:/m.test(match[1] ?? "");
}

describe("runner/agent/schedules/: eve's own cron-discovery directory must never hold an undeclared schedule", () => {
  it("is absent, or holds no .md files (P08-B's schedules live in runner/scheduler/prompts/ instead)", async () => {
    const files = await markdownFilesIn(EVE_SCHEDULES_DIR);
    expect(files).toEqual([]);
  });

  it("regression guard: any .md that does show up here must declare cron frontmatter, or eve build fails the same way B1 did", async () => {
    const files = await markdownFilesIn(EVE_SCHEDULES_DIR);
    const missingCron: string[] = [];
    for (const file of files) {
      const content = await readFile(path.join(EVE_SCHEDULES_DIR, file), "utf8");
      if (!hasCronFrontmatter(content)) missingCron.push(file);
    }
    expect(missingCron).toEqual([]);
  });
});

describe("scheduler/config.ts: SCHEDULES_PROMPT_DIR", () => {
  it("points at runner/scheduler/prompts/, not runner/agent/schedules/", () => {
    expect(SCHEDULES_PROMPT_DIR).toBe(path.join(RUNNER_DIR, "scheduler", "prompts"));
  });

  it("every schedule's promptFile actually exists under SCHEDULES_PROMPT_DIR", async () => {
    for (const schedule of SCHEDULES) {
      const content = await readFile(path.join(SCHEDULES_PROMPT_DIR, schedule.promptFile), "utf8");
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
