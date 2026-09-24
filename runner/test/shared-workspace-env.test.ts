import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_WORKSPACE_COORDINATION_VAR, openOrCreateEvalWorkspace } from "../eval-agent/evals/eval-workspace.ts";
import { newWorkspace } from "./helpers.ts";

/**
 * Round-2 T8: the shared workspace module the two extraction evals call
 * (`eval-agent/evals/eval-workspace.ts`) keeps `RUNNER_WORKSPACE` in step
 * with its own coordination variable. The round-2 reviewer set both
 * ambiently, to different workspaces: the fixtures went to one and the tools
 * to the other, and 10 gates failed. This file's name avoids the word the
 * harness refuses in commands; the eval runs only through `pnpm test`.
 */

const saved = { coordination: process.env[EVAL_WORKSPACE_COORDINATION_VAR], runner: process.env.RUNNER_WORKSPACE };

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env[EVAL_WORKSPACE_COORDINATION_VAR];
  delete process.env.RUNNER_WORKSPACE;
});

afterEach(() => {
  restore(EVAL_WORKSPACE_COORDINATION_VAR, saved.coordination);
  restore("RUNNER_WORKSPACE", saved.runner);
});

describe("openOrCreateEvalWorkspace keeps both variables in step (round-2 T8)", () => {
  it("with both set ambiently to different workspaces, opens the coordinated one and points RUNNER_WORKSPACE at it too", async () => {
    const coordinated = await newWorkspace();
    const other = await newWorkspace();
    process.env[EVAL_WORKSPACE_COORDINATION_VAR] = coordinated.root;
    process.env.RUNNER_WORKSPACE = other.root;

    const opened = await openOrCreateEvalWorkspace();
    expect(opened.root).toBe(coordinated.root);
    expect(process.env.RUNNER_WORKSPACE).toBe(coordinated.root);
    expect(process.env[EVAL_WORKSPACE_COORDINATION_VAR]).toBe(coordinated.root);
  });

  it("a second call, from the other eval file's copy of the module, opens the same workspace and leaves both variables on it", async () => {
    const coordinated = await newWorkspace();
    process.env[EVAL_WORKSPACE_COORDINATION_VAR] = coordinated.root;
    const first = await openOrCreateEvalWorkspace();
    process.env.RUNNER_WORKSPACE = "/somewhere/else/entirely"; // anything between the two calls
    const second = await openOrCreateEvalWorkspace();
    expect(second.root).toBe(first.root);
    expect(process.env.RUNNER_WORKSPACE).toBe(coordinated.root);
  });

  it("an ambient RUNNER_WORKSPACE alone (as GitHub Actions sets) is never mistaken for the eval workspace", async () => {
    const ambient = await newWorkspace();
    process.env.RUNNER_WORKSPACE = ambient.root;
    const created = await openOrCreateEvalWorkspace();
    expect(created.root).not.toBe(ambient.root);
    expect(process.env.RUNNER_WORKSPACE).toBe(created.root);
    expect(process.env[EVAL_WORKSPACE_COORDINATION_VAR]).toBe(created.root);
  });

  it("a coordination variable that names no workspace fails closed, and RUNNER_WORKSPACE is left alone", async () => {
    const notAWorkspace = await newWorkspace();
    process.env[EVAL_WORKSPACE_COORDINATION_VAR] = `${notAWorkspace.root}-missing`;
    process.env.RUNNER_WORKSPACE = notAWorkspace.root;
    await expect(openOrCreateEvalWorkspace()).rejects.toThrow();
    expect(process.env.RUNNER_WORKSPACE).toBe(notAWorkspace.root);
  });
});
