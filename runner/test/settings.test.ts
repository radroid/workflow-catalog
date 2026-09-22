import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { ModelSettingsError, readModelSettings } from "../agent/lib/model.ts";
import { parseFlags } from "../cli/args.ts";
import { parseCodexLoginStatus, evePathEnv } from "../lib/codex.ts";
import { EnvFileError, serializeEnv, updateEnvFile } from "../lib/env-file.ts";
import { loadSettings, settingsFromValues } from "../lib/settings.ts";
import { tempDir } from "./helpers.ts";

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
