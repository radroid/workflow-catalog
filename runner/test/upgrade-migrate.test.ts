import { describe, expect, it } from "vitest";
import type { MigrationFileIO, WorkspaceMigration } from "../../packages/contracts/migrations/types.ts";
import { newWorkspace } from "./helpers.ts";
import { loadMigrations, MigrationError, MigrationLoadError, runMigrations } from "../upgrade/migrate.ts";

function step(from: string, to: string, migrate: (io: MigrationFileIO) => Promise<void>): WorkspaceMigration {
  return { from, to, description: `${from} -> ${to} (test fixture)`, migrate };
}

describe("loadMigrations (the real packages/contracts/migrations directory)", () => {
  it("finds the shipped 0.1.0 -> 0.2.0 fixture migration and skips types.ts", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    const one = migrations.find((m) => m.from === "0.1.0" && m.to === "0.2.0");
    expect(one).toBeDefined();
    expect(typeof one?.migrate).toBe("function");
  });

  it("returns [] for a directory that does not exist, rather than throwing", async () => {
    expect(await loadMigrations("/tmp/wc-p10b-no-such-migrations-dir")).toEqual([]);
  });
});

describe("runMigrations", () => {
  it("is a no-op when currentVersion already equals targetVersion", async () => {
    const workspace = await newWorkspace();
    const result = await runMigrations({ currentVersion: "0.1.0", targetVersion: "0.1.0", workspace, migrations: [] });
    expect(result.ranSteps).toEqual([]);
  });

  it("refuses to migrate backward", async () => {
    const workspace = await newWorkspace();
    await expect(runMigrations({ currentVersion: "0.2.0", targetVersion: "0.1.0", workspace, migrations: [] })).rejects.toThrow(/backward/);
  });

  it("runs a single step and commits its staged write to the real workspace", async () => {
    const workspace = await newWorkspace();
    const migrations = [step("0.1.0", "0.2.0", async (io) => io.writeJson("marker.json", { touched: true }))];
    const result = await runMigrations({ currentVersion: "0.1.0", targetVersion: "0.2.0", workspace, migrations });
    expect(result.ranSteps).toEqual([{ from: "0.1.0", to: "0.2.0", description: migrations[0]!.description }]);
    expect(await workspace.readJson("marker.json")).toEqual({ touched: true });
  });

  it("chains consecutive steps across a multi-version jump, in order", async () => {
    const order: string[] = [];
    const migrations = [
      step("0.1.0", "0.2.0", async (io) => {
        order.push("a");
        await io.writeJson("marker.json", { step: "a" });
      }),
      step("0.2.0", "0.3.0", async (io) => {
        order.push("b");
        const previous = (await io.readJson("marker.json")) as { step: string };
        await io.writeJson("marker.json", { step: "b", sawPrevious: previous.step });
      }),
    ];
    const workspace = await newWorkspace();
    const result = await runMigrations({ currentVersion: "0.1.0", targetVersion: "0.3.0", workspace, migrations });
    expect(order).toEqual(["a", "b"]);
    expect(result.ranSteps.map((s) => `${s.from}->${s.to}`)).toEqual(["0.1.0->0.2.0", "0.2.0->0.3.0"]);
    expect(await workspace.readJson("marker.json")).toEqual({ step: "b", sawPrevious: "a" });
  });

  it("refuses when there is a gap in the chain (no migration whose from matches the cursor), and writes nothing", async () => {
    const workspace = await newWorkspace();
    const migrations = [step("0.1.0", "0.2.0", async (io) => io.writeJson("marker.json", { touched: true }))];
    await expect(runMigrations({ currentVersion: "0.1.0", targetVersion: "0.4.0", workspace, migrations })).rejects.toThrow(MigrationError);
    expect(await workspace.readJson("marker.json")).toBeUndefined();
  });

  it("refuses when two migrations both claim the same from version", async () => {
    const workspace = await newWorkspace();
    const migrations = [step("0.1.0", "0.2.0", async () => undefined), step("0.1.0", "0.3.0", async () => undefined)];
    await expect(runMigrations({ currentVersion: "0.1.0", targetVersion: "0.3.0", workspace, migrations })).rejects.toThrow(MigrationLoadError);
  });

  it("a failed step leaves the workspace unchanged: an earlier step's write is never committed either", async () => {
    const workspace = await newWorkspace();
    const migrations = [
      step("0.1.0", "0.2.0", async (io) => io.writeJson("marker.json", { fromFirstStep: true })),
      step("0.2.0", "0.3.0", async () => {
        throw new Error("simulated failure in the second step");
      }),
    ];
    await expect(runMigrations({ currentVersion: "0.1.0", targetVersion: "0.3.0", workspace, migrations })).rejects.toThrow(MigrationError);
    // Neither step's effect reached disk: the first step's write was only staged, and staging is discarded on throw.
    expect(await workspace.readJson("marker.json")).toBeUndefined();
    expect(await workspace.readJson("workspace.json")).toMatchObject({ packageVersion: "0.1.0" });
  });

  it("a migration sees its own earlier staged write, not the stale on-disk value", async () => {
    const workspace = await newWorkspace();
    await workspace.writeJson(["marker.json"], { value: "on-disk" });
    const migrations = [
      step("0.1.0", "0.2.0", async (io) => io.writeJson("marker.json", { value: "staged-by-step-1" })),
      step("0.2.0", "0.3.0", async (io) => {
        const seen = (await io.readJson("marker.json")) as { value: string };
        await io.writeJson("marker.json", { value: `${seen.value}-then-step-2` });
      }),
    ];
    const workspace2 = workspace; // clarity: same instance used throughout
    await runMigrations({ currentVersion: "0.1.0", targetVersion: "0.3.0", workspace: workspace2, migrations });
    expect(await workspace.readJson("marker.json")).toEqual({ value: "staged-by-step-1-then-step-2" });
  });
});
