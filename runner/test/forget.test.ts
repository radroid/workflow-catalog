import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { executeForget, planForget } from "../lib/forget.ts";
import { noPrompter } from "../lib/prompt.ts";
import { EVE_SECRET_NAMES, EVE_SECRET_SERVICE, MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { loadSettings } from "../lib/settings.ts";
import { runSetup } from "../lib/setup.ts";
import { tempDir } from "./helpers.ts";

/** Every file under `dir`, relative, sorted. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        out.push(`${child}/`);
        await walk(child);
      } else out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

/** A fake install: a runner folder with code, setup run against a temp home, eve build output, a key, eve's sign-in. */
async function fakeInstall(options: { provider?: "chatgpt" | "openai" } = {}) {
  const root = await tempDir("wc-forget-");
  const repo = path.join(root, "repo");
  const runnerDir = path.join(repo, "runner");
  const home = path.join(root, "home");
  await mkdir(path.join(runnerDir, "agent"), { recursive: true });
  await writeFile(path.join(runnerDir, "agent", "agent.ts"), "// code, not data\n");
  await mkdir(path.join(runnerDir, "eval-agent"));
  await writeFile(path.join(runnerDir, "eval-agent", "package.json"), "{}\n");
  await mkdir(home);
  const secrets = new MemorySecretStore();
  const envFile = path.join(runnerDir, ".env.local");
  const provider = options.provider ?? "openai";
  const result = await runSetup(
    { workspace: path.join(root, "JobAssistant"), provider, model: provider === "openai" ? "gpt-5.6-terra" : "gpt-5.6-luna", apiKeyEnv: provider === "openai" ? "WC_KEY" : undefined, yes: true },
    {
      envFile,
      repoRoot: repo,
      homeDir: home,
      clock: new ManualClock(),
      secrets,
      prompter: noPrompter,
      out: () => undefined,
      findCodex: async () => "/opt/fake-tools/bin/codex",
      codexStatus: async () => ({ loggedIn: true, detail: "Logged in using ChatGPT" }),
      packageVersion: "0.1.0",
      env: { WC_KEY: "sk-fictional-key" },
      nodeVersion: "24.18.0",
    },
  );
  return { root, repo, runnerDir, home, secrets, envFile, workspace: result.workspace };
}

describe("uninstall footprint", () => {
  it("setup writes only runner/.env.local, the workspace, and (for an API key) one keychain entry", async () => {
    const install = await fakeInstall();
    expect(await tree(install.runnerDir)).toEqual([".env.local", "agent/", "agent/agent.ts", "eval-agent/", "eval-agent/package.json"]);
    expect(await tree(install.home)).toEqual([]);
    expect(await readdir(install.root)).toEqual(expect.arrayContaining(["JobAssistant", "home", "repo"]));
    expect(await readdir(install.root)).toHaveLength(3);
    expect([...install.secrets.entries.keys()].map((key) => key.replace("\u0000", " / "))).toEqual([`${RUNNER_SECRET_SERVICE} / openai-key`]);
  });

  it("forget finds and removes all of it: runner state, eve state, the workspace, our key and eve's sign-in", async () => {
    const install = await fakeInstall();
    for (const dir of [".eve/.workflow-data", ".output/server", "eval-agent/.eve"]) await mkdir(path.join(install.runnerDir, dir), { recursive: true });
    await writeFile(path.join(install.runnerDir, ".eve", ".workflow-data", "session.json"), "{}");
    for (const name of EVE_SECRET_NAMES.slice(0, 2)) await install.secrets.set(EVE_SECRET_SERVICE, name, "fictional");
    await mkdir(path.join(install.home, ".eve", "auth"), { recursive: true });
    await writeFile(path.join(install.home, ".eve", "connection.json"), "{}");
    await writeFile(path.join(install.home, ".eve", "auth", "chatgpt.json"), "{}");

    const settings = await loadSettings({ envFile: install.envFile, env: {} });
    const plan = await planForget({ runnerDir: install.runnerDir, envFile: install.envFile, settings, secrets: install.secrets, homeDir: install.home });
    const labels = plan.items.map((entry) => entry.label).join("\n");
    for (const expected of ["runner/.env.local", "runner/.eve/", "runner/.output/", "runner/eval-agent/.eve/", "the workspace", "workflow-catalog-runner / openai-key", "eve / chatgpt", "eve / openai-key", "~/.eve/connection.json", "chatgpt.json"]) {
      expect(labels).toContain(expected);
    }
    expect(plan.items.filter((entry) => entry.owner === "eve")).toHaveLength(4);
    expect(plan.notes.join("\n")).toContain("codex logout");

    const outcome = await executeForget(plan, install.secrets);
    expect(outcome.failed).toEqual([]);
    expect(await tree(install.runnerDir)).toEqual(["agent/", "agent/agent.ts", "eval-agent/", "eval-agent/package.json"]);
    expect(await readdir(install.root)).toEqual(["home", "repo"]);
    expect(await tree(install.home)).toEqual([".eve/", ".eve/auth/"]);
    expect(install.secrets.entries.size).toBe(0);
    const again = await planForget({ runnerDir: install.runnerDir, envFile: install.envFile, settings, secrets: install.secrets, homeDir: install.home });
    expect(again.items).toEqual([]);
  });

  it("keeps the workspace with --keep-workspace, and never removes a folder that is not a workspace", async () => {
    const install = await fakeInstall({ provider: "chatgpt" });
    const settings = await loadSettings({ envFile: install.envFile, env: {} });
    const kept = await planForget({ runnerDir: install.runnerDir, envFile: install.envFile, settings, secrets: install.secrets, homeDir: install.home, keepWorkspace: true });
    expect(kept.items.some((entry) => entry.path === install.workspace.root)).toBe(false);
    const stranger = path.join(install.root, "someone-elses-folder");
    await mkdir(stranger);
    await writeFile(path.join(stranger, "workspace.json"), "{\"not\":\"ours\"}");
    const other = await planForget({
      runnerDir: install.runnerDir,
      envFile: install.envFile,
      settings: { ...settings, workspace: stranger },
      secrets: install.secrets,
      homeDir: install.home,
    });
    expect(other.items.some((entry) => entry.path === stranger)).toBe(false);
    expect(other.notes.join("\n")).toContain("no valid workspace.json");
  });
});
