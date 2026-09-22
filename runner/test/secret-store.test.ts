import { describe, expect, it } from "vitest";
import {
  createLinuxSecretServiceStore,
  createMacosKeychainStore,
  createUnavailableStore,
  decodeSecretField,
  encodeSecretField,
  type CommandRunner,
} from "../lib/secret-store.ts";

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string | undefined;
}

function recorder(respond: (call: Call) => { code: number; stdout?: string; stderr?: string }): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, input) => {
      const call = { command, args, input };
      calls.push(call);
      const result = respond(call);
      return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  };
}

describe("secret encoding (compatible with the just-secrets store eve bundles)", () => {
  it("prefixes base64 with secrets:v1:", () => {
    expect(encodeSecretField("eve")).toBe("secrets:v1:ZXZl");
    expect(decodeSecretField(encodeSecretField("sk-fictional/ü"))).toBe("sk-fictional/ü");
    expect(() => decodeSecretField("plain")).toThrow();
    expect(() => decodeSecretField("secrets:v1:not base64!")).toThrow();
  });
});

describe("macOS keychain store", () => {
  it("passes the value on stdin, never as an argument", async () => {
    const { run, calls } = recorder(() => ({ code: 0 }));
    await createMacosKeychainStore(run).set("workflow-catalog-runner", "openai-key", "sk-fictional-secret");
    const [call] = calls;
    expect(call?.command).toBe("/usr/bin/security");
    expect(call?.args).toEqual(["-q", "-i"]);
    expect(call?.args.join(" ")).not.toContain("sk-fictional-secret");
    expect(call?.input).toContain(`"${encodeSecretField("sk-fictional-secret")}"`);
    expect(call?.input).toContain(`"-s" "${encodeSecretField("workflow-catalog-runner")}" "-a" "${encodeSecretField("openai-key")}"`);
  });

  it("reads, checks presence without the password flag, and treats exit 44 as absent", async () => {
    const { run, calls } = recorder((call) => (call.args.includes("-w") ? { code: 0, stdout: `${encodeSecretField("sk-fictional")}\n` } : { code: 44 }));
    const store = createMacosKeychainStore(run);
    expect(await store.get("eve", "chatgpt")).toBe("sk-fictional");
    expect(await store.has("eve", "chatgpt")).toBe(false);
    expect(calls[1]?.args).not.toContain("-w");
    expect(await store.delete("eve", "chatgpt")).toBe(false);
  });

  it("reports a locked keychain as an error", async () => {
    const { run } = recorder(() => ({ code: 36 }));
    await expect(createMacosKeychainStore(run).get("eve", "chatgpt")).rejects.toThrow(/locked/);
  });
});

describe("Linux Secret Service store", () => {
  it("uses the just-secrets attributes and passes the value on stdin", async () => {
    const { run, calls } = recorder((call) => (call.args[0] === "lookup" ? { code: 1 } : { code: 0 }));
    const store = createLinuxSecretServiceStore(run);
    await store.set("workflow-catalog-runner", "anthropic-key", "sk-fictional");
    expect(calls[0]?.args).toEqual([
      "store",
      "--label=secrets",
      "--",
      "application",
      "secrets",
      "service",
      encodeSecretField("workflow-catalog-runner"),
      "name",
      encodeSecretField("anthropic-key"),
    ]);
    expect(calls[0]?.input).toBe(encodeSecretField("sk-fictional"));
    expect(await store.get("workflow-catalog-runner", "anthropic-key")).toBeNull();
  });
});

describe("unavailable store", () => {
  it("refuses to store and finds nothing", async () => {
    const store = createUnavailableStore("no store here");
    await expect(store.set("a", "b", "c")).rejects.toThrow("no store here");
    expect(await store.has("a", "b")).toBe(false);
  });
});
