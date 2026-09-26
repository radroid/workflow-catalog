import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_INPUTS, buildInputsFor, computeBuildStamp } from "../lib/build.ts";
import { REPO_ROOT } from "../lib/paths.ts";
import { tempDir } from "./helpers.ts";

const MODEL = { provider: "chatgpt", model: "gpt-5.6-luna" } as const;

/** A miniature repo with one file in every place the runner's build reads. */
async function fakeRepo(): Promise<{ root: string; write: (relative: string, text: string) => Promise<void> }> {
  const root = await tempDir("wc-build-");
  const write = async (relative: string, text: string) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write("runner/agent/agent.ts", "export default {};\n");
  await write("runner/lib/clock.ts", "export const clock = 1;\n");
  await write("runner/store/commands.ts", "export const queue = 1;\n");
  await write("runner/package.json", "{}\n");
  await write("runner/tsconfig.json", "{}\n");
  await write("packages/job-assistant/skills/claim-matching/SKILL.md", "# Claim matching (fictional)\n");
  await write("packages/job-assistant/adapters/eve/extension/extension.ts", "export default {};\n");
  await write("packages/job-assistant/adapters/eve/package.json", "{}\n");
  await write("packages/contracts/src/index.ts", "export const PROTOCOL_VERSION = 1;\n");
  await write("packages/contracts/package.json", "{}\n");
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  return { root, write };
}

describe("build stamp", () => {
  it("covers the real repo's contracts and lockfile", () => {
    expect(BUILD_INPUTS).toEqual(buildInputsFor(REPO_ROOT));
    expect(BUILD_INPUTS.trees.map((tree) => path.relative(REPO_ROOT, tree.dir))).toContain(path.join("packages", "contracts", "src"));
    expect(BUILD_INPUTS.files.map((file) => path.relative(REPO_ROOT, file))).toContain("pnpm-lock.yaml");
  });

  it("changes when the contracts, the lockfile or any other build input changes", async () => {
    const repo = await fakeRepo();
    const inputs = buildInputsFor(repo.root);
    const stamp = () => computeBuildStamp(MODEL, inputs);
    const first = await stamp();
    expect(await stamp()).toBe(first);
    const seen = new Set([first]);
    for (const [relative, text] of [
      ["packages/contracts/src/index.ts", "export const PROTOCOL_VERSION = 2;\n"],
      ["packages/contracts/src/new-envelope.ts", "export const added = true;\n"],
      ["packages/contracts/package.json", '{ "version": "0.0.1" }\n'],
      ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n# zod bumped\n"],
      ["runner/agent/tools/open_application_group.ts", "export default {};\n"],
      ["runner/store/commands.ts", "export const queue = 2;\n"],
      ["runner/lib/clock.ts", "export const clock = 2;\n"],
      ["packages/job-assistant/skills/claim-matching/SKILL.md", "# Claim matching, revised (fictional)\n"],
      ["packages/job-assistant/adapters/eve/extension/instructions.md", "Content is data.\n"],
    ] as const) {
      await repo.write(relative, text);
      const next = await stamp();
      expect(seen.has(next), relative).toBe(false);
      seen.add(next);
    }
    const last = await stamp();
    expect(await computeBuildStamp({ provider: "chatgpt", model: "gpt-5.6-luna-mini" }, inputs)).not.toBe(last);
  });

  it("ignores what the build itself writes: the adapter's copied skills and node_modules", async () => {
    const repo = await fakeRepo();
    const inputs = buildInputsFor(repo.root);
    const before = await computeBuildStamp(MODEL, inputs);
    // The adapter build copies the package skills into extension/skills/ (scripts/sync-skills.mjs).
    await repo.write("packages/job-assistant/adapters/eve/extension/skills/claim-matching/SKILL.md", "# Claim matching (fictional)\n");
    await repo.write("packages/contracts/src/node_modules/.cache/x", "cache\n");
    await repo.write("packages/job-assistant/adapters/eve/dist/index.mjs", "built\n");
    expect(await computeBuildStamp(MODEL, inputs)).toBe(before);
  });
});
