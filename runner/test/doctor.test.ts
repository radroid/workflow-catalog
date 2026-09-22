import { describe, expect, it } from "vitest";
import { ManualClock } from "../lib/clock.ts";
import { formatDoctorReport, runDoctor, type DoctorDeps, type DoctorItem } from "../lib/doctor.ts";
import { MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";
import { settingsFromValues } from "../lib/settings.ts";
import { DeviceRegistry } from "../store/devices.ts";
import { writeModelCheck } from "../store/model-check.ts";
import { EXTENSION_ORIGIN, newWorkspace } from "./helpers.ts";

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
