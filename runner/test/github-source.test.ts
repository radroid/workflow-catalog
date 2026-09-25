import { describe, expect, it } from "vitest";
import {
  buildGithubSourceText,
  githubTokenStatus,
  resolveGithubToken,
  GITHUB_TOKEN_SECRET_NAME,
  type GithubFetchResult,
  type GithubSourceDeps,
} from "../lib/github-source.ts";
import { MemorySecretStore, RUNNER_SECRET_SERVICE } from "../lib/secret-store.ts";

/**
 * `github-source.ts`'s own tests (P03.1 packet acceptance: "Against a fake
 * GitHub API, the source text lists the fixture repositories"; "The token
 * appears in no file, journal entry, log line or response"; "`forget`
 * removes the entry" — that last one is `forget.test.ts`'s). Every test
 * builds its own `GithubSourceDeps`: a `MemorySecretStore` (never the OS
 * keychain), a scripted `getGhCliToken` (never spawns `gh`), and a scripted
 * `fetchGithub` (never a real HTTPS call to api.github.com).
 */

const FICTIONAL_TOKEN = "github_pat_fictional_northwind_0123456789";

function deps(overrides: Partial<GithubSourceDeps> = {}): GithubSourceDeps {
  return {
    getGhCliToken: async () => null,
    secrets: new MemorySecretStore(),
    fetchGithub: async () => ({ ok: false, reason: "network", message: "not scripted for this test" }),
    ...overrides,
  };
}

function reposResponse(repos: ReadonlyArray<Record<string, unknown>>): GithubFetchResult {
  return { ok: true, json: repos };
}

function readmeResponse(text: string): GithubFetchResult {
  return { ok: true, json: { content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" } };
}

const FIXTURE_REPOS = [
  { name: "ledgerkit", full_name: "ada-quill/ledgerkit", description: "An open-source ledger reconciliation library.", language: "TypeScript", topics: ["finance", "ledger"] },
  { name: "harbor-tools", full_name: "ada-quill/harbor-tools", description: "Deployment tooling used at Harbor.", language: "Go", topics: [] },
];

describe("resolveGithubToken", () => {
  it("prefers the gh CLI token over the keychain", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME, "keychain-token");
    const resolved = await resolveGithubToken(deps({ getGhCliToken: async () => "cli-token", secrets }));
    expect(resolved).toEqual({ source: "gh-cli", token: "cli-token" });
  });

  it("falls back to the keychain entry when gh isn't signed in", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME, FICTIONAL_TOKEN);
    const resolved = await resolveGithubToken(deps({ getGhCliToken: async () => null, secrets }));
    expect(resolved).toEqual({ source: "keychain", token: FICTIONAL_TOKEN });
  });

  it("is undefined when neither is available", async () => {
    const resolved = await resolveGithubToken(deps());
    expect(resolved).toBeUndefined();
  });

  it("treats a blank gh CLI answer as not signed in", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME, FICTIONAL_TOKEN);
    const resolved = await resolveGithubToken(deps({ getGhCliToken: async () => "   ", secrets }));
    expect(resolved).toEqual({ source: "keychain", token: FICTIONAL_TOKEN });
  });
});

describe("githubTokenStatus", () => {
  it("reports availability and source, never the token", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME, FICTIONAL_TOKEN);
    const status = await githubTokenStatus(deps({ secrets }));
    expect(status).toEqual({ available: true, source: "keychain" });
    expect(JSON.stringify(status)).not.toContain(FICTIONAL_TOKEN);
  });

  it("reports unavailable when there's no token anywhere", async () => {
    expect(await githubTokenStatus(deps())).toEqual({ available: false, source: null });
  });
});

describe("buildGithubSourceText", () => {
  it("lists the fixture repositories' name, description, language and topics, with their READMEs", async () => {
    const calls: string[] = [];
    const result = await buildGithubSourceText(
      deps({
        getGhCliToken: async () => FICTIONAL_TOKEN,
        fetchGithub: async (path) => {
          calls.push(path);
          if (path.startsWith("/user/repos")) return reposResponse(FIXTURE_REPOS);
          if (path === "/repos/ada-quill/ledgerkit/readme") return readmeResponse("Ledgerkit reconciles ledgers.");
          if (path === "/repos/ada-quill/harbor-tools/readme") return readmeResponse("Deploy tooling for Harbor.");
          throw new Error(`unscripted path: ${path}`);
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.repoCount).toBe(2);
    expect(result.text).toContain("## ada-quill/ledgerkit");
    expect(result.text).toContain("An open-source ledger reconciliation library.");
    expect(result.text).toContain("Language: TypeScript");
    expect(result.text).toContain("Topics: finance, ledger");
    expect(result.text).toContain("Ledgerkit reconciles ledgers.");
    expect(result.text).toContain("## ada-quill/harbor-tools");
    expect(result.text).toContain("Deploy tooling for Harbor.");
    expect(result.text.match(/^Topics: /gm)?.length).toBe(1); // only ledgerkit's — harbor-tools has no topics, so no empty "Topics:" line for it
    expect(calls).toEqual(["/user/repos?affiliation=owner&per_page=30&sort=updated", "/repos/ada-quill/ledgerkit/readme", "/repos/ada-quill/harbor-tools/readme"]);
  });

  it("still composes repo text when a README fetch fails (no README is not a fatal error)", async () => {
    const result = await buildGithubSourceText(
      deps({
        getGhCliToken: async () => FICTIONAL_TOKEN,
        fetchGithub: async (path) => {
          if (path.startsWith("/user/repos")) return reposResponse(FIXTURE_REPOS.slice(0, 1));
          return { ok: false, reason: "http_error", message: "HTTP 404" };
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toContain("## ada-quill/ledgerkit");
    expect(result.text).not.toContain("README:");
  });

  it("truncates a README to the documented cap", async () => {
    const longReadme = "x".repeat(5000);
    const result = await buildGithubSourceText(
      deps({
        getGhCliToken: async () => FICTIONAL_TOKEN,
        fetchGithub: async (path) => (path.startsWith("/user/repos") ? reposResponse(FIXTURE_REPOS.slice(0, 1)) : readmeResponse(longReadme)),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text.length).toBeLessThan(longReadme.length);
    expect(result.text).toContain("x".repeat(2000));
    expect(result.text).not.toContain("x".repeat(2001));
  });

  it("refuses with no_token when neither the gh CLI nor the keychain has one", async () => {
    const result = await buildGithubSourceText(deps());
    expect(result).toEqual({ ok: false, reason: "no_token", message: "No GitHub token yet. Sign in with `gh auth login`, or paste a token below." });
  });

  it("refuses with empty when the account has no repositories", async () => {
    const result = await buildGithubSourceText(deps({ getGhCliToken: async () => FICTIONAL_TOKEN, fetchGithub: async () => reposResponse([]) }));
    expect(result).toEqual({ ok: false, reason: "empty", message: "Your GitHub account has no repositories to import." });
  });

  it("propagates the repos-list fetch failure's reason and message directly (unauthorized)", async () => {
    const result = await buildGithubSourceText(
      deps({ getGhCliToken: async () => FICTIONAL_TOKEN, fetchGithub: async () => ({ ok: false, reason: "unauthorized", message: "The GitHub token was refused. Check that it's still valid." }) }),
    );
    expect(result).toEqual({ ok: false, reason: "unauthorized", message: "The GitHub token was refused. Check that it's still valid." });
  });

  it("propagates a rate-limited failure", async () => {
    const result = await buildGithubSourceText(
      deps({ getGhCliToken: async () => FICTIONAL_TOKEN, fetchGithub: async () => ({ ok: false, reason: "rate_limited", message: "GitHub's API rate limit was reached. Try again later." }) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("rate_limited");
  });

  it("never includes the token in the composed text or in any refusal message, across every path", async () => {
    const secretToken = "github_pat_super-secret-value-should-never-leak";
    const outcomes = await Promise.all([
      buildGithubSourceText(deps({ getGhCliToken: async () => secretToken, fetchGithub: async () => reposResponse(FIXTURE_REPOS) })),
      buildGithubSourceText(deps({ getGhCliToken: async () => secretToken, fetchGithub: async () => ({ ok: false, reason: "unauthorized", message: "The GitHub token was refused. Check that it's still valid." }) })),
      buildGithubSourceText(deps({ getGhCliToken: async () => secretToken, fetchGithub: async () => reposResponse([]) })),
    ]);
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(secretToken);
    }
  });
});
