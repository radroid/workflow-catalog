import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { workspaceManifestSchema } from "@workflow-catalog/contracts";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import type { CodexLoginStatus } from "../lib/codex.ts";
import { noPrompter, scriptedPrompter, type Prompter } from "../lib/prompt.ts";
import { MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { checkWorkspacePath, runSetup, SetupError, type SetupDeps, type SetupOptions } from "../lib/setup.ts";
import { PairingCodes } from "../store/pairing.ts";
import { WorkspaceError } from "../store/workspace.ts";
import { newWorkspace, tempDir } from "./helpers.ts";

interface Sandbox {
  readonly root: string;
  readonly runnerDir: string;
  readonly envFile: string;
  readonly home: string;
  readonly repo: string;
  readonly secrets: MemorySecretStore;
  readonly out: string[];
  deps(overrides?: Partial<SetupDeps>): SetupDeps;
}

const LOGGED_IN: CodexLoginStatus = { loggedIn: true, method: "ChatGPT", detail: "Logged in using ChatGPT" };

async function sandbox(): Promise<Sandbox> {
  const root = await tempDir("wc-setup-");
  const repo = path.join(root, "repo");
  const runnerDir = path.join(repo, "runner");
  const home = path.join(root, "home");
  await mkdir(runnerDir, { recursive: true });
  await mkdir(home);
  const secrets = new MemorySecretStore();
  const out: string[] = [];
  const envFile = path.join(runnerDir, ".env.local");
  return {
    root,
    runnerDir,
    envFile,
    home,
    repo,
    secrets,
    out,
    deps: (overrides = {}) => ({
      envFile,
      repoRoot: repo,
      homeDir: home,
      clock: new ManualClock(),
      secrets,
      prompter: noPrompter,
      out: (line: string) => out.push(line),
      findCodex: async () => "/opt/fake-tools/bin/codex",
      codexStatus: async () => LOGGED_IN,
      packageVersion: "0.1.0",
      env: {},
      nodeVersion: "24.18.0",
      ...overrides,
    }),
  };
}

const CHATGPT: SetupOptions = { provider: "chatgpt", model: "gpt-5.6-luna", yes: true };

async function readEnv(file: string): Promise<Record<string, string | undefined>> {
  return parseEnv(await readFile(file, "utf8"));
}

describe("setup (non-interactive)", () => {
  it("writes .env.local with the privacy switches, model, workspace and two fresh secrets, mode 0600", async () => {
    const box = await sandbox();
    const result = await runSetup({ ...CHATGPT, workspace: path.join(box.root, "ws") }, box.deps());
    const env = await readEnv(box.envFile);
    expect(env.EVE_TELEMETRY_DISABLED).toBe("1");
    expect(env.EVE_TRACES_CONTENT).toBe("off");
    expect(env.RUNNER_MODEL_PROVIDER).toBe("chatgpt");
    expect(env.RUNNER_MODEL).toBe("gpt-5.6-luna");
    expect(env.RUNNER_CODEX_DIR).toBe("/opt/fake-tools/bin");
    expect(env.RUNNER_WORKSPACE).toBe(result.workspace.root);
    expect(env.ROUTE_AUTH_BASIC_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.RUNNER_UI_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.RUNNER_UI_TOKEN).not.toBe(env.ROUTE_AUTH_BASIC_PASSWORD);
    expect((await stat(box.envFile)).mode & 0o777).toBe(0o600);
    expect(Object.keys(env).sort()).toEqual(
      ["EVE_TELEMETRY_DISABLED", "EVE_TRACES_CONTENT", "RUNNER_MODEL_PROVIDER", "RUNNER_MODEL", "RUNNER_CODEX_DIR", "RUNNER_WORKSPACE", "ROUTE_AUTH_BASIC_PASSWORD", "RUNNER_UI_TOKEN"].sort(),
    );
    expect(result.providerConnected).toBe(true);
    expect(box.secrets.entries.size).toBe(0);
  });

  it("creates the workspace, and prints a pairing code the bridge will accept", async () => {
    const box = await sandbox();
    const result = await runSetup({ ...CHATGPT, workspace: path.join(box.root, "ws") }, box.deps());
    expect(workspaceManifestSchema.parse(JSON.parse(await readFile(path.join(result.workspace.root, "workspace.json"), "utf8"))).packageVersion).toBe("0.1.0");
    expect(box.out.join("\n")).toContain(`Pairing code: ${result.pairing.code}`);
    expect(await new PairingCodes(result.workspace, new ManualClock()).redeem(result.pairing.code)).toBe("ok");
  });

  it("keeps the workspace and both secrets on a re-run, and updates the model", async () => {
    const box = await sandbox();
    const first = await runSetup({ ...CHATGPT, workspace: path.join(box.root, "ws") }, box.deps());
    const before = await readEnv(box.envFile);
    const second = await runSetup({ provider: "chatgpt", model: "gpt-5.6-terra", yes: true }, box.deps());
    const after = await readEnv(box.envFile);
    expect(second.createdWorkspace).toBe(false);
    expect(second.workspace.manifest.workspaceId).toBe(first.workspace.manifest.workspaceId);
    expect(after.ROUTE_AUTH_BASIC_PASSWORD).toBe(before.ROUTE_AUTH_BASIC_PASSWORD);
    expect(after.RUNNER_UI_TOKEN).toBe(before.RUNNER_UI_TOKEN);
    expect(after.RUNNER_MODEL).toBe("gpt-5.6-terra");
  });

  it("never takes the workspace from the environment (P02.2 revision 1, W1, W5: B exists on disk), only --workspace or .env.local choose it, never an ambient value", async () => {
    const box = await sandbox();
    const ambient = (await newWorkspace()).root;
    // --yes, no --workspace, a first run: the environment never supplies it — setup fails, asking for one explicitly, exactly as with no ambient value at all — even though `ambient` is a real, valid, pre-existing workspace and old (buggy) code would have happily opened it.
    await expect(runSetup({ ...CHATGPT }, box.deps({ env: { RUNNER_WORKSPACE: ambient } }))).rejects.toThrow(/--workspace/);
    // Interactive, no --workspace, a first run: the suggested default stays ~/JobAssistant (here, <home>/JobAssistant), never the ambient value.
    let offeredDefault: string | undefined;
    const prompter: Prompter = {
      ask: async (question, defaultValue) => {
        if (/Workspace folder/.test(question)) offeredDefault = defaultValue;
        return defaultValue ?? "";
      },
      askSecret: async () => "",
      confirm: async (_question, defaultValue) => defaultValue,
    };
    await runSetup({ yes: false }, box.deps({ env: { RUNNER_WORKSPACE: ambient }, prompter }));
    expect(offeredDefault).toBe(path.join(box.home, "JobAssistant"));

    // A real first run, with --workspace: creates A.
    const first = await runSetup({ ...CHATGPT, workspace: path.join(box.root, "wsA") }, box.deps());
    // A re-run, no --workspace, a *different*, also real and valid, ambient value: .env.local already names A, so it wins — unaffected by W1 (only the first-run fallback was reverted).
    const decoy = (await newWorkspace()).root;
    const second = await runSetup({ provider: "chatgpt", model: "gpt-5.6-terra", yes: true }, box.deps({ env: { RUNNER_WORKSPACE: decoy } }));
    expect(second.workspace.root).toBe(first.workspace.root);
    expect(second.createdWorkspace).toBe(false);
  });

  it("requires an explicit model for ChatGPT: eve's default is rejected for ChatGPT accounts", async () => {
    const box = await sandbox();
    await expect(runSetup({ provider: "chatgpt", workspace: path.join(box.root, "ws"), yes: true }, box.deps())).rejects.toThrow(/--model/);
  });

  it("refuses Node older than 24", async () => {
    const box = await sandbox();
    await expect(runSetup({ ...CHATGPT, workspace: path.join(box.root, "ws") }, box.deps({ nodeVersion: "22.12.0" }))).rejects.toThrow(/Node 24/);
  });

  it("explains codex login when Codex is missing or signed out, and still records the settings", async () => {
    const box = await sandbox();
    const missing = await runSetup({ ...CHATGPT, workspace: path.join(box.root, "ws") }, box.deps({ findCodex: async () => undefined }));
    expect(missing.providerConnected).toBe(false);
    expect(box.out.join("\n")).toMatch(/Codex CLI was not found/);
    // Mode A signs in only through Codex; eve dev never runs in runner/ (README condition 4).
    expect(box.out.join("\n")).not.toMatch(/eve dev|\/login/);
    expect((await readEnv(box.envFile)).RUNNER_CODEX_DIR).toBeUndefined();
    const signedOut = await runSetup({ ...CHATGPT }, box.deps({ codexStatus: async () => ({ loggedIn: false, detail: "Not logged in" }) }));
    expect(signedOut.providerConnected).toBe(false);
    expect(box.out.join("\n")).toContain("codex login");
  });

  it("stores an API key in the OS keychain, never in .env.local or the workspace", async () => {
    const box = await sandbox();
    const key = "sk-test-fictional-0123456789";
    const result = await runSetup(
      { provider: "openai", model: "gpt-5.6-terra", apiKeyEnv: "WC_TEST_KEY", workspace: path.join(box.root, "ws"), yes: true },
      box.deps({ env: { WC_TEST_KEY: key } }),
    );
    expect(await box.secrets.get(RUNNER_SECRET_SERVICE, "openai-key")).toBe(key);
    expect(await readFile(box.envFile, "utf8")).not.toContain(key);
    const everything: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else everything.push(await readFile(full, "utf8"));
      }
    };
    await walk(result.workspace.root);
    expect(everything.join("\n")).not.toContain(key);
    expect((await readEnv(box.envFile)).RUNNER_CODEX_DIR).toBeUndefined();
  });

  it("keeps an API key that is already stored", async () => {
    const box = await sandbox();
    await box.secrets.set(RUNNER_SECRET_SERVICE, "anthropic-key", "stored-key-fictional");
    const result = await runSetup({ provider: "anthropic", model: "claude-fictional-1", workspace: path.join(box.root, "ws"), yes: true }, box.deps());
    expect(result.providerConnected).toBe(true);
    expect(box.out.join("\n")).toContain("already stored");
  });

  it("asks the questions when interactive", async () => {
    const box = await sandbox();
    const prompter: Prompter & { asked: string[] } = scriptedPrompter([path.join(box.root, "ws"), "chatgpt", ""]);
    const result = await runSetup({ yes: false }, box.deps({ prompter }));
    expect(result.model).toEqual({ provider: "chatgpt", model: "gpt-5.6-luna" });
    expect(prompter.asked).toHaveLength(3);
  });
});

describe("workspace folder rules", () => {
  it("refuses the disk root, the home folder, the repository and unsafe characters", async () => {
    const root = await tempDir("wc-paths-");
    const context = { homeDir: path.join(root, "home"), repoRoot: path.join(root, "repo") };
    await mkdir(context.homeDir);
    await mkdir(context.repoRoot);
    for (const input of ["/", "~", context.homeDir, context.repoRoot, path.join(context.repoRoot, "data"), path.join(root, 'say "hi"'), path.join(root, "a\\b"), ""]) {
      await expect(checkWorkspacePath(input, context), input).rejects.toBeInstanceOf(SetupError);
    }
    expect(await checkWorkspacePath("~/JobAssistant", context)).toMatch(/home\/JobAssistant$/);
  });

  it("never adopts a non-empty folder", async () => {
    const box = await sandbox();
    const busy = path.join(box.root, "busy");
    await mkdir(busy);
    await writeFile(path.join(busy, "thesis.txt"), "not the runner's");
    await expect(runSetup({ ...CHATGPT, workspace: busy }, box.deps())).rejects.toBeInstanceOf(WorkspaceError);
  });
});
