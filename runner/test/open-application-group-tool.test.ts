import { openApplicationGroupSchema } from "@workflow-catalog/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import productionTool, { type OpenApplicationGroupOutput } from "../agent/tools/open_application_group.ts";
import evalTool from "../eval-agent/agent/tools/open_application_group.ts";
import { systemClock } from "../lib/clock.ts";
import { CommandQueue } from "../store/commands.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { OUTBOX_DIR, OUTBOX_FILE, SessionsStore } from "../store/sessions.ts";
import type { Workspace } from "../store/workspace.ts";
import { EXTENSION_ORIGIN, newWorkspace } from "./helpers.ts";
import { FERNWOOD_JOB, fixtureJob, HOSTILE_JOB } from "./preparation-helpers.ts";
import { seedApplication } from "./session-helpers.ts";

/**
 * The model's one action, `open_application_group` (P06 owns its body), in both app roots: the eval agent
 * re-exports the real tool, so the evals check the real approval gate. Its input is task IDs only; each resolves
 * to the job URL the runner stored, never to anything a posting says, and it only ever creates new files in the
 * workspace (it runs in eve's process, with `RUNNER_WORKSPACE`, as in production). Fictional data only.
 */

type Tool = { execute(input: unknown, ctx: unknown): Promise<OpenApplicationGroupOutput>; approval?: unknown };

const ROOTS = [
  { root: "agent (production)", tool: productionTool as unknown as Tool },
  { root: "eval-agent", tool: evalTool as unknown as Tool },
];

const previous = process.env.RUNNER_WORKSPACE;
let workspace: Workspace;

beforeEach(async () => {
  workspace = await newWorkspace();
  process.env.RUNNER_WORKSPACE = workspace.root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.RUNNER_WORKSPACE;
  else process.env.RUNNER_WORKSPACE = previous;
});

for (const { root, tool } of ROOTS) {
  describe(`open_application_group (${root})`, () => {
    it("is the same approval-gated tool in both roots", () => {
      expect(evalTool).toBe(productionTool);
      expect(tool.approval).toBeDefined();
    });

    it("queues one command for the paired browser, with each task's stored job URL and never the posting's own apply address", async () => {
      const { device } = await new DeviceRegistry(workspace, systemClock).register(EXTENSION_ORIGIN);
      const fernwood = await seedApplication(workspace, systemClock, fixtureJob(FERNWOOD_JOB));
      const quill = await seedApplication(workspace, systemClock, fixtureJob(HOSTILE_JOB));
      const output = await tool.execute({ taskIds: [fernwood.taskId, quill.taskId] }, {});
      expect(output).toMatchObject({ status: "queued", applications: 2, delivery: "browser" });
      const [record] = await new CommandQueue(workspace, systemClock).list();
      const command = openApplicationGroupSchema.parse(record!.command);
      expect(command.deviceId).toBe(device.deviceId);
      expect(command.payload.items.map((item) => item.url)).toEqual([FERNWOOD_JOB.url, HOSTILE_JOB.url]);
      expect(JSON.stringify(command)).not.toContain("/apply");
    });

    it("with no paired browser, writes the session to outbox/ instead", async () => {
      const fernwood = await seedApplication(workspace, systemClock, fixtureJob(FERNWOOD_JOB));
      const output = await tool.execute({ taskIds: [fernwood.taskId] }, {});
      expect(output).toMatchObject({ status: "queued", delivery: "outbox" });
      expect(await workspace.readJson(OUTBOX_DIR, OUTBOX_FILE)).toMatchObject({ items: [{ taskId: fernwood.taskId, url: FERNWOOD_JOB.url }] });
      expect(await new CommandQueue(workspace, systemClock).list()).toEqual([]);
    });

    it("refuses, opening nothing, for a task that isn't Ready or isn't an application", async () => {
      await new DeviceRegistry(workspace, systemClock).register(EXTENSION_ORIGIN);
      const saved = await seedApplication(workspace, systemClock, fixtureJob(FERNWOOD_JOB), "saved");
      expect(await tool.execute({ taskIds: [saved.taskId] }, {})).toMatchObject({ status: "refused", code: "not_ready" });
      expect(await tool.execute({ taskIds: ["5d0c8a64-2f0b-4f3e-9a55-3c7f1b0e6d21"] }, {})).toMatchObject({ status: "refused", code: "application_not_found" });
      expect(await new CommandQueue(workspace, systemClock).list()).toEqual([]);
      expect((await new SessionsStore(workspace, systemClock).list()).sessions).toEqual([]);
    });
  });
}
