import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEveEnv } from "../lib/eve-env.ts";

/**
 * eve's child environment (P02.2 deliverable 4; revision 1, W4). `buildEveEnv`
 * is a pure function in its own module (lib/eve-env.ts), never cli/runner.ts's
 * top-level script, so importing it here never loads the real settings,
 * probes a real port, or spawns eve.
 */
describe("buildEveEnv", () => {
  it("the resolved workspace (settings.values) overrides an ambient one already in the process environment", () => {
    const env = buildEveEnv({
      processEnv: { RUNNER_WORKSPACE: "/ambient/from-shell", HOME: "/Users/ada" },
      settingsValues: { RUNNER_WORKSPACE: "/resolved/from-env-local" },
    });
    expect(env.RUNNER_WORKSPACE).toBe("/resolved/from-env-local");
    expect(env.HOME).toBe("/Users/ada"); // an unrelated key from the process environment survives
  });

  it("settings.values wins generally, not only for the workspace, since it is spread after the process environment", () => {
    const env = buildEveEnv({
      processEnv: { RUNNER_MODEL: "gpt-5.6-luna", ONLY_IN_PROCESS: "kept" },
      settingsValues: { RUNNER_MODEL: "gpt-5.6-terra" },
    });
    expect(env.RUNNER_MODEL).toBe("gpt-5.6-terra");
    expect(env.ONLY_IN_PROCESS).toBe("kept");
  });

  it("strips PORT and HOST: eve is given its own on the command line, and must not inherit a stray one", () => {
    const env = buildEveEnv({
      processEnv: { PORT: "9999", HOST: "0.0.0.0" },
      settingsValues: {},
    });
    expect(env.PORT).toBeUndefined();
    expect(env.HOST).toBeUndefined();
  });

  it("puts the privacy switches on top, even if the environment or settings.values turned them off", () => {
    const env = buildEveEnv({
      processEnv: { EVE_TELEMETRY_DISABLED: "0" },
      settingsValues: { EVE_TELEMETRY_DISABLED: "0", EVE_TRACES_CONTENT: "on" },
    });
    expect(env.EVE_TELEMETRY_DISABLED).toBe("1");
    expect(env.EVE_TRACES_CONTENT).toBe("off");
  });

  it("puts codex's directory first on PATH when one is given", () => {
    const env = buildEveEnv({ processEnv: {}, settingsValues: {}, codexDir: "/opt/fake-tools/bin" });
    expect(env.PATH?.split(path.delimiter)[0]).toBe("/opt/fake-tools/bin");
  });

  it("R2-N5: takes the rest of PATH from its own processEnv option, never the real process.env.PATH", () => {
    // A regression guard for the P02.2 round-2 finding: evePathEnv's `inherited`
    // parameter used to default straight to the global process.env.PATH
    // because buildEveEnv never passed options.processEnv.PATH through. A
    // deliberately fictional, single-entry PATH here proves the real
    // process's PATH (which this test process definitely has, and which is
    // never this exact fictional value) is not what ends up in the result.
    const env = buildEveEnv({ processEnv: { PATH: "/only/injected/bin" }, settingsValues: {} });
    expect(env.PATH).toBe([path.dirname(process.execPath), "/only/injected/bin"].join(path.delimiter));
  });

  it("R2-N5: an injected PATH combines with codexDir the same way the real process.env.PATH would", () => {
    const env = buildEveEnv({ processEnv: { PATH: "/only/injected/bin" }, settingsValues: {}, codexDir: "/opt/fake-tools/bin" });
    expect(env.PATH).toBe(["/opt/fake-tools/bin", path.dirname(process.execPath), "/only/injected/bin"].join(path.delimiter));
  });
});
