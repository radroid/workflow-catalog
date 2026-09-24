import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { formatDoctorReport, runDoctor, type DoctorDeps, type DoctorItem } from "../lib/doctor.ts";
import { serializeEnv } from "../lib/env-file.ts";
import { MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { loadSettings, settingsFromValues } from "../lib/settings.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { writeModelCheck } from "../store/model-check.ts";
import { EXTENSION_ORIGIN, newWorkspace, tempDir } from "./helpers.ts";

const SECRET_A = "A".repeat(43);
const SECRET_B = "B".repeat(43);

async function install(options: { provider?: string; model?: string; paired?: boolean; verified?: boolean | "failed"; privacy?: boolean } = {}) {
  const clock = new ManualClock();
  const workspace = await newWorkspace(clock);
  const provider = options.provider ?? "chatgpt";
  const model = options.model ?? "gpt-5.6-luna";
  if (options.paired !== false) await new DeviceRegistry(workspace, clock).register(EXTENSION_ORIGIN);
  if (options.verified !== undefined) {
    await writeModelCheck(workspace, {
      provider,
      model,
      ok: options.verified === true,
      checkedAt: clock.now().toISOString(),
      via: "doctor",
      ...(options.verified === "failed" ? { detail: "HTTP 400: model not supported" } : {}),
    });
  }
  const values: Record<string, string> = {
    RUNNER_MODEL_PROVIDER: provider,
    RUNNER_MODEL: model,
    RUNNER_WORKSPACE: workspace.root,
    RUNNER_CODEX_DIR: "/opt/fake-tools/bin",
    ROUTE_AUTH_BASIC_PASSWORD: SECRET_A,
    RUNNER_UI_TOKEN: SECRET_B,
    ...(options.privacy === false ? {} : { EVE_TELEMETRY_DISABLED: "1", EVE_TRACES_CONTENT: "off" }),
  };
  return { clock, workspace, values };
}

function deps(values: Record<string, string>, clock: ManualClock, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    settings: settingsFromValues(values, true),
    clock,
    secrets: new MemorySecretStore(),
    nodeVersion: "24.18.0",
    findCodex: async () => "/opt/fake-tools/bin/codex",
    codexStatus: async () => ({ loggedIn: true, method: "ChatGPT", detail: "Logged in using ChatGPT" }),
    evePin: async () => ({ ok: true, installed: "0.63.0", problems: [] }),
    dependenciesInstalled: async () => [],
    ...overrides,
  };
}

function item(items: readonly DoctorItem[], id: DoctorItem["id"]): DoctorItem {
  const found = items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} item`);
  return found;
}

/** A real runner/.env.local, an install's values loaded through loadSettings (not settingsFromValues), so the workspace precedence and mismatch fields are the real ones. */
async function loadedSettings(values: Record<string, string>, env: Record<string, string | undefined>) {
  const dir = await tempDir("wc-p022-doctor-");
  const envFile = path.join(dir, ".env.local");
  await writeFile(envFile, serializeEnv(values));
  return loadSettings({ envFile, env });
}

/** values.RUNNER_WORKSPACE, non-null: install() always sets it. */
function workspaceOf(values: Record<string, string>): string {
  const value = values.RUNNER_WORKSPACE;
  if (!value) throw new Error("install() did not set RUNNER_WORKSPACE");
  return value;
}

describe("doctor", () => {
  it("has the catalog install page's five items, then privacy and the eve pin, all required", async () => {
    const { clock, values } = await install({ verified: true });
    const report = await runDoctor(deps(values, clock));
    expect(report.items.map((entry) => [entry.id, entry.label])).toEqual([
      ["node", "Node 24 present"],
      ["runner", "Runner installed"],
      ["provider", "Provider connected"],
      ["workspace", "Workspace chosen"],
      ["extension", "Extension paired"],
      ["privacy", "Privacy settings"],
      ["eve", "eve pinned to 0.63.0"],
    ]);
    expect(report.items.every((entry) => entry.required)).toBe(true);
  });

  it("is all green on a finished install with a verified model", async () => {
    const { clock, values } = await install({ verified: true });
    const report = await runDoctor(deps(values, clock));
    expect(report.items.map((entry) => entry.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(report.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("warns, without failing, while the model is unverified; fails after a failed check", async () => {
    const unverified = await install();
    const warn = await runDoctor(deps(unverified.values, unverified.clock));
    expect(item(warn.items, "provider").status).toBe("warn");
    expect(item(warn.items, "provider").fix).toContain("--live");
    expect(warn.ok).toBe(true);
    const failed = await install({ verified: "failed" });
    const fail = await runDoctor(deps(failed.values, failed.clock));
    expect(item(fail.items, "provider").status).toBe("fail");
    expect(fail.ok).toBe(false);
  });

  it("does not count a check of a different model as verified", async () => {
    const { clock, values } = await install({ verified: true });
    const report = await runDoctor(deps({ ...values, RUNNER_MODEL: "gpt-5.6-terra" }, clock));
    expect(item(report.items, "provider").status).toBe("warn");
  });

  it("fails the provider when Codex is missing or signed out", async () => {
    const { clock, values } = await install({ verified: true });
    const missing = await runDoctor(deps(values, clock, { findCodex: async () => undefined }));
    expect(item(missing.items, "provider").status).toBe("fail");
    expect(item(missing.items, "provider").fix).toMatch(/codex/i);
    const signedOut = await runDoctor(deps(values, clock, { codexStatus: async () => ({ loggedIn: false, detail: "Not logged in" }) }));
    expect(item(signedOut.items, "provider").status).toBe("fail");
    expect(signedOut.ok).toBe(false);
  });

  it("checks for an API key in the keychain for API providers, without reading it", async () => {
    const { clock, values } = await install({ provider: "openai", model: "gpt-5.6-terra", verified: true });
    const missing = await runDoctor(deps(values, clock));
    expect(item(missing.items, "provider").status).toBe("fail");
    const secrets = new MemorySecretStore();
    await secrets.set(RUNNER_SECRET_SERVICE, "openai-key", "sk-fictional");
    let reads = 0;
    const counting = { ...secrets, kind: "memory", available: true, has: secrets.has.bind(secrets), set: secrets.set.bind(secrets), delete: secrets.delete.bind(secrets), get: async () => {
      reads += 1;
      return null;
    } };
    const present = await runDoctor(deps(values, clock, { secrets: counting }));
    expect(item(present.items, "provider").status).toBe("ok");
    expect(reads).toBe(0);
  });

  it("fails each missing piece with its fix", async () => {
    const { clock, values } = await install({ verified: true, paired: false, privacy: false });
    const report = await runDoctor(deps(values, clock, { nodeVersion: "22.12.0", evePin: async () => ({ ok: false, installed: "0.64.0", problems: ["runner/package.json declares eve \"^0.63.0\""] }) }));
    for (const id of ["node", "extension", "privacy", "eve"] as const) {
      expect(item(report.items, id).status, id).toBe("fail");
      expect(item(report.items, id).fix, id).toBeTruthy();
    }
    expect(report.ok).toBe(false);
    const noSetup = await runDoctor(deps({}, clock));
    expect(item(noSetup.items, "runner").status).toBe("fail");
    expect(item(noSetup.items, "workspace").status).toBe("fail");
    expect(item(noSetup.items, "provider").status).toBe("fail");
    const noPackages = await runDoctor(deps(values, clock, { dependenciesInstalled: async () => ["eve"] }));
    expect(item(noPackages.items, "runner").detail).toContain("eve");
  });

  it("does not count an expired device as paired", async () => {
    const { clock, values } = await install({ verified: true });
    clock.advance(31 * 24 * 60 * 60 * 1000);
    const report = await runDoctor(deps(values, clock));
    expect(item(report.items, "extension").status).toBe("fail");
  });

  it("prints a readable checklist", async () => {
    const { clock, values } = await install();
    const text = formatDoctorReport(await runDoctor(deps(values, clock)));
    expect(text).toContain("[ok]   Node 24 present");
    expect(text).toContain("[warn] Provider connected");
    expect(text).toContain("All required checks pass.");
  });
});

describe("doctor: RUNNER_WORKSPACE mismatch (P02.2)", () => {
  it("warns, without failing, when the environment's RUNNER_WORKSPACE differs from .env.local's, naming both", async () => {
    const { clock, values } = await install({ verified: true });
    const ambient = "/home/runner/work/workflow-catalog/workflow-catalog"; // not a workspace, as GitHub Actions sets
    const settings = await loadedSettings(values, { RUNNER_WORKSPACE: ambient });
    expect(settings.workspace).toBe(values.RUNNER_WORKSPACE);
    const report = await runDoctor(deps(settings.values, clock, { settings }));
    const workspace = item(report.items, "workspace");
    expect(workspace.status).toBe("warn");
    expect(workspace.detail).toContain(values.RUNNER_WORKSPACE);
    expect(workspace.detail).toContain(ambient);
    expect(workspace.detail.toLowerCase()).toContain("ignored");
    expect(workspace.fix).toBeTruthy();
    expect(report.ok).toBe(true);
  });

  it("stays ok, with no mention of a mismatch, when the environment agrees or sets nothing", async () => {
    const { clock, values } = await install({ verified: true });
    for (const env of [{ RUNNER_WORKSPACE: values.RUNNER_WORKSPACE }, {}]) {
      const settings = await loadedSettings(values, env);
      const report = await runDoctor(deps(settings.values, clock, { settings }));
      expect(item(report.items, "workspace").status, JSON.stringify(env)).toBe("ok");
      expect(item(report.items, "workspace").detail, JSON.stringify(env)).toBe(values.RUNNER_WORKSPACE);
    }
  });

  it("mentions the ignored ambient value when .env.local's own workspace fails to open (N5)", async () => {
    const { clock, values } = await install({ verified: true });
    const broken = { ...values, RUNNER_WORKSPACE: path.join(workspaceOf(values), "does-not-exist") };
    const ambient = "/home/runner/work/workflow-catalog/workflow-catalog";
    const settings = await loadedSettings(broken, { RUNNER_WORKSPACE: ambient });
    const report = await runDoctor(deps(settings.values, clock, { settings }));
    const workspace = item(report.items, "workspace");
    expect(workspace.status).toBe("fail");
    expect(workspace.detail).toContain(ambient);
  });
});

describe("doctor: workspace comparison by real folder, not string (P02.2 revision 1, W2)", () => {
  it("does not warn when the environment spells .env.local's workspace differently: a trailing slash, a symlink, or .. segments", async () => {
    const { clock, values } = await install({ verified: true });
    const A = workspaceOf(values);
    const scratch = await tempDir("wc-p022-w2-");
    const linkToA = path.join(scratch, "link-to-A");
    await symlink(A, linkToA);
    const spellings: Record<string, string> = {
      "a trailing slash": `${A}/`,
      "a symlink": linkToA,
      "\"..\" segments": path.join(A, "..", path.basename(A)),
    };
    for (const [label, spelling] of Object.entries(spellings)) {
      const settings = await loadedSettings(values, { RUNNER_WORKSPACE: spelling });
      const report = await runDoctor(deps(settings.values, clock, { settings }));
      expect(item(report.items, "workspace").status, label).toBe("ok");
      expect(item(report.items, "workspace").detail, label).toBe(A);
    }
  });

  it("still warns when the environment names a genuinely different, real workspace (W5: B exists on disk)", async () => {
    const { clock, values } = await install({ verified: true });
    const B = await newWorkspace(clock);
    const settings = await loadedSettings(values, { RUNNER_WORKSPACE: B.root });
    const report = await runDoctor(deps(settings.values, clock, { settings }));
    const workspace = item(report.items, "workspace");
    expect(workspace.status).toBe("warn");
    expect(workspace.detail).toContain(values.RUNNER_WORKSPACE);
    expect(workspace.detail).toContain(B.root);
  });

  it("the fix line names the flag that would adopt the ambient value into .env.local (W6/N3)", async () => {
    const { clock, values } = await install({ verified: true });
    const B = await newWorkspace(clock);
    const settings = await loadedSettings(values, { RUNNER_WORKSPACE: B.root });
    const report = await runDoctor(deps(settings.values, clock, { settings }));
    expect(item(report.items, "workspace").fix).toContain("npm run setup -- --workspace <path>");
  });
});
