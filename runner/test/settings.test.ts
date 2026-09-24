import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { ModelSettingsError, readModelSettings } from "../agent/lib/model.ts";
import { parseFlags } from "../cli/args.ts";
import { ManualClock } from "../lib/clock.ts";
import { parseCodexLoginStatus, evePathEnv } from "../lib/codex.ts";
import { EnvFileError, serializeEnv, updateEnvFile } from "../lib/env-file.ts";
import { loadSettings, settingsFromValues } from "../lib/settings.ts";
import { newWorkspace, tempDir } from "./helpers.ts";

describe(".env.local", () => {
  it("writes values that eve's parser (node:util.parseEnv) reads back unchanged", () => {
    const values = {
      RUNNER_WORKSPACE: "/Users/ada quill/Job Assistant",
      RUNNER_MODEL: "openai/gpt-5.6-terra",
      ROUTE_AUTH_BASIC_PASSWORD: "abc_DEF-123".padEnd(43, "x"),
      EVE_TRACES_CONTENT: "off",
      EMPTY: "",
      HASH: "a#b",
    };
    const text = serializeEnv(values, { header: ["Written by setup."], order: ["EVE_TRACES_CONTENT"] });
    expect(parseEnv(text)).toEqual(values);
    expect(text.split("\n")[0]).toBe("# Written by setup.");
    expect(text.split("\n")[1]).toBe("EVE_TRACES_CONTENT=off");
  });

  it("refuses values it cannot write safely", () => {
    for (const value of ['say "hi"', "back\\slash", "two\nlines", "tick`", "bell\u0007"]) {
      expect(() => serializeEnv({ KEY: value }), JSON.stringify(value)).toThrow(EnvFileError);
    }
    expect(() => serializeEnv({ "BAD-KEY": "x" })).toThrow(EnvFileError);
  });

  it("keeps keys the person added and deletes keys set to undefined", async () => {
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, "MY_OWN=kept\nRUNNER_CODEX_DIR=/old\n");
    await updateEnvFile(file, { RUNNER_MODEL: "gpt-5.6-luna", RUNNER_CODEX_DIR: undefined });
    expect(parseEnv(await readFile(file, "utf8"))).toEqual({ MY_OWN: "kept", RUNNER_MODEL: "gpt-5.6-luna" });
  });
});

describe("settings", () => {
  it("reads the file, lets the process environment win, and validates secrets", async () => {
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(
      file,
      [
        "RUNNER_MODEL_PROVIDER=chatgpt",
        "RUNNER_MODEL=gpt-5.6-luna",
        `ROUTE_AUTH_BASIC_PASSWORD=${"p".repeat(43)}`,
        "RUNNER_UI_TOKEN=short",
        "EVE_TELEMETRY_DISABLED=1",
        "EVE_TRACES_CONTENT=on",
      ].join("\n"),
    );
    const settings = await loadSettings({ envFile: file, env: { RUNNER_MODEL: "gpt-5.6-terra" } });
    expect(settings.model).toEqual({ provider: "chatgpt", model: "gpt-5.6-terra" });
    expect(settings.routePassword).toBe("p".repeat(43));
    expect(settings.uiToken).toBeUndefined();
    expect(settings.privacy).toEqual({ telemetryDisabled: true, tracesOff: false });
    const missing = await loadSettings({ envFile: path.join(path.dirname(file), "missing"), env: {} });
    expect(missing.envFileFound).toBe(false);
    expect(missing.modelError).toMatch(/npm run setup/);
  });

  it("validates the model settings", () => {
    expect(readModelSettings({ RUNNER_MODEL_PROVIDER: "gateway", RUNNER_MODEL: "openai/gpt-5.6-terra" })).toEqual({ provider: "gateway", model: "openai/gpt-5.6-terra" });
    for (const env of [
      {},
      { RUNNER_MODEL_PROVIDER: "chatgpt" },
      { RUNNER_MODEL_PROVIDER: "bedrock", RUNNER_MODEL: "x" },
      { RUNNER_MODEL_PROVIDER: "chatgpt", RUNNER_MODEL: "gpt 5; rm -rf" },
      { RUNNER_MODEL_PROVIDER: "gateway", RUNNER_MODEL: "gpt-5.6-terra" },
    ]) {
      expect(() => readModelSettings(env), JSON.stringify(env)).toThrow(ModelSettingsError);
    }
    expect(settingsFromValues({}, false).model).toBeUndefined();
  });
});

describe("workspace precedence", () => {
  it("keeps .env.local's workspace once setup has written it, even when the environment names another valid workspace (W5: B exists on disk)", async () => {
    const clock = new ManualClock();
    const A = await newWorkspace(clock);
    const B = await newWorkspace(clock);
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, `RUNNER_WORKSPACE=${A.root}\n`);
    const settings = await loadSettings({ envFile: file, env: { RUNNER_WORKSPACE: B.root } });
    expect(settings.workspace).toBe(A.root);
    expect(settings.values.RUNNER_WORKSPACE).toBe(A.root);
    expect(settings.workspaceEnvOverride).toBe(B.root);
  });

  it("keeps .env.local's workspace even when the environment names a folder that isn't a workspace at all, as GitHub Actions sets one", async () => {
    const clock = new ManualClock();
    const A = await newWorkspace(clock);
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, `RUNNER_WORKSPACE=${A.root}\n`);
    const notAWorkspace = "/home/runner/work/workflow-catalog/workflow-catalog";
    const settings = await loadSettings({ envFile: file, env: { RUNNER_WORKSPACE: notAWorkspace } });
    expect(settings.workspace).toBe(A.root);
    expect(settings.values.RUNNER_WORKSPACE).toBe(A.root);
    expect(settings.workspaceEnvOverride).toBe(notAWorkspace);
  });

  it("lets the environment supply the workspace when .env.local has none, as for tests and a first run (W5: B exists on disk)", async () => {
    const clock = new ManualClock();
    const B = await newWorkspace(clock);
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, "RUNNER_MODEL=gpt-5.6-luna\n");
    const settings = await loadSettings({ envFile: file, env: { RUNNER_WORKSPACE: B.root } });
    expect(settings.workspace).toBe(B.root);
    expect(settings.values.RUNNER_WORKSPACE).toBe(B.root);
    expect(settings.workspaceEnvOverride).toBeUndefined();
  });

  it("does not flag a mismatch when the environment agrees, is blank, or is unset", async () => {
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, "RUNNER_WORKSPACE=/Users/ada/WorkspaceA\n");
    for (const env of [{ RUNNER_WORKSPACE: "/Users/ada/WorkspaceA" }, { RUNNER_WORKSPACE: "  " }, {}]) {
      const settings = await loadSettings({ envFile: file, env });
      expect(settings.workspace, JSON.stringify(env)).toBe("/Users/ada/WorkspaceA");
      expect(settings.workspaceEnvOverride, JSON.stringify(env)).toBeUndefined();
    }
  });

  it("keeps every other key's precedence (the environment wins) alongside the workspace exception", async () => {
    const file = path.join(await tempDir(), ".env.local");
    await writeFile(file, "RUNNER_WORKSPACE=/Users/ada/WorkspaceA\nRUNNER_MODEL=gpt-5.6-luna\n");
    const settings = await loadSettings({ envFile: file, env: { RUNNER_WORKSPACE: "/Users/ada/WorkspaceB", RUNNER_MODEL: "gpt-5.6-terra" } });
    expect(settings.workspace).toBe("/Users/ada/WorkspaceA");
    expect(settings.values.RUNNER_MODEL).toBe("gpt-5.6-terra");
  });

  it("records the workspace source (W3): \"file\" once .env.local has one, \"env\" only before that, undefined with neither", async () => {
    const clock = new ManualClock();
    const A = await newWorkspace(clock);
    const B = await newWorkspace(clock);
    const withFile = path.join(await tempDir(), ".env.local");
    await writeFile(withFile, `RUNNER_WORKSPACE=${A.root}\n`);
    expect((await loadSettings({ envFile: withFile, env: { RUNNER_WORKSPACE: B.root } })).workspaceSource).toBe("file");
    expect((await loadSettings({ envFile: withFile, env: {} })).workspaceSource).toBe("file");

    const withoutKey = path.join(await tempDir(), ".env.local");
    await writeFile(withoutKey, "RUNNER_MODEL=gpt-5.6-luna\n");
    expect((await loadSettings({ envFile: withoutKey, env: { RUNNER_WORKSPACE: B.root } })).workspaceSource).toBe("env");

    const missing = path.join(await tempDir(), "missing.envfile");
    expect((await loadSettings({ envFile: missing, env: { RUNNER_WORKSPACE: B.root } })).workspaceSource).toBe("env");
    expect((await loadSettings({ envFile: missing, env: {} })).workspaceSource).toBeUndefined();
  });
});

describe("script flags", () => {
  it("reads flags after --, and npm's own spelling of boolean flags (npm run doctor --json)", () => {
    const options = { json: { type: "boolean" as const }, workspace: { type: "string" as const } };
    expect(parseFlags(["--json", "--workspace", "/tmp/ws"], options, ["json"], {})).toMatchObject({ json: true, workspace: "/tmp/ws" });
    expect(parseFlags([], options, ["json"], { npm_config_json: "true" })).toMatchObject({ json: true });
    expect(parseFlags([], options, ["json"], {}).json).toBeUndefined();
    expect(() => parseFlags(["--nope"], options, [], {})).toThrow();
  });
});

describe("codex", () => {
  it("reads `codex login status`", () => {
    expect(parseCodexLoginStatus({ code: 0, output: "Logged in using ChatGPT\n" })).toEqual({ loggedIn: true, method: "ChatGPT", detail: "Logged in using ChatGPT" });
    expect(parseCodexLoginStatus({ code: 1, output: "Not logged in\n" }).loggedIn).toBe(false);
    expect(parseCodexLoginStatus({ code: 0, output: "Not logged in\n" }).loggedIn).toBe(false);
    expect(parseCodexLoginStatus({ code: -1, output: "spawn ENOENT" }).loggedIn).toBe(false);
  });

  it("puts codex's directory first on eve's PATH, then node's", () => {
    const parts = evePathEnv("/opt/fake-tools/bin", "/usr/bin:/bin").split(path.delimiter);
    expect(parts[0]).toBe("/opt/fake-tools/bin");
    expect(parts[1]).toBe(path.dirname(process.execPath));
    expect(parts).toContain("/usr/bin");
  });
});
