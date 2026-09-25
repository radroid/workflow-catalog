import { RUNNER_SECRET_SERVICE, createOsSecretStore, runCommand, type SecretStore } from "./secret-store.ts";

/**
 * The repositories source (P03.1, mvp-spec §4 "GitHub: read-only token
 * (`gh auth token` if present, else a fine-grained PAT pasted once, stored
 * in the OS keychain)"). Read-only: only GET requests, only the person's own
 * repositories, only what F4 asks for (name, description, languages,
 * topics, README up to a cap).
 *
 * The token never appears in a log line, a workspace file or a response:
 * every function here returns a plain, fixed message on failure, never a
 * thrown error's own text (which could echo request details) and never the
 * raw GitHub response body. `server/routes/onboarding.ts` is the only
 * caller, and it never echoes `resolveGithubToken`'s `token` field back to
 * the page either.
 *
 * Everything that could touch the real world is behind `GithubSourceDeps`,
 * an injectable, mutable object — the same seam as `routes/onboarding.ts`'s
 * `extractionTiming`. `defaultGithubSourceDeps` is the production wiring
 * (`gh auth token`, the OS keychain, `fetch` to api.github.com); tests
 * overwrite its fields in place with fakes (`MemorySecretStore`, a scripted
 * `getGhCliToken`, a scripted `fetchGithub`) and restore them afterwards, so
 * a test can never reach the real keychain, `gh`, or GitHub.
 */

export const GITHUB_TOKEN_SECRET_NAME = "github-token";

export type GithubTokenSource = "gh-cli" | "keychain";

export type GithubFetchFailureReason = "unauthorized" | "rate_limited" | "network" | "http_error";

export type GithubFetchResult =
  | { readonly ok: true; readonly json: unknown }
  | { readonly ok: false; readonly reason: GithubFetchFailureReason; readonly message: string };

export interface GithubSourceDeps {
  /** `gh auth token`'s stdout, trimmed, or null when `gh` isn't signed in (or isn't installed). Never throws. */
  getGhCliToken(): Promise<string | null>;
  readonly secrets: SecretStore;
  /** One GET to `https://api.github.com<path>`, bearer-authenticated. Never throws. */
  fetchGithub(path: string, token: string): Promise<GithubFetchResult>;
}

async function defaultGetGhCliToken(): Promise<string | null> {
  try {
    const result = await runCommand("gh", ["auth", "token"]);
    if (result.code !== 0) return null;
    const token = result.stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

async function defaultFetchGithub(path: string, token: string): Promise<GithubFetchResult> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "workflow-catalog-runner/0.1 (+onboarding github import)",
      },
    });
  } catch {
    return { ok: false, reason: "network", message: "Could not reach GitHub. Check the connection and try again." };
  }
  if (response.status === 401 || response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") return { ok: false, reason: "rate_limited", message: "GitHub's API rate limit was reached. Try again later." };
    return { ok: false, reason: "unauthorized", message: "The GitHub token was refused. Check that it's still valid." };
  }
  if (!response.ok) return { ok: false, reason: "http_error", message: `GitHub answered with an error (HTTP ${response.status}).` };
  try {
    return { ok: true, json: await response.json() };
  } catch {
    return { ok: false, reason: "http_error", message: "GitHub's answer couldn't be read." };
  }
}

/** The production wiring. Tests overwrite these fields with fakes, in place, and restore them afterwards. */
export const defaultGithubSourceDeps: GithubSourceDeps = {
  getGhCliToken: defaultGetGhCliToken,
  secrets: createOsSecretStore(),
  fetchGithub: defaultFetchGithub,
};

/** `gh auth token` first, else the keychain entry; undefined when neither has one. Never throws. */
export async function resolveGithubToken(deps: Pick<GithubSourceDeps, "getGhCliToken" | "secrets">): Promise<{ readonly source: GithubTokenSource; readonly token: string } | undefined> {
  const cli = await deps.getGhCliToken().catch(() => null);
  if (cli && cli.trim()) return { source: "gh-cli", token: cli.trim() };
  const stored = await deps.secrets.get(RUNNER_SECRET_SERVICE, GITHUB_TOKEN_SECRET_NAME).catch(() => null);
  if (stored && stored.trim()) return { source: "keychain", token: stored.trim() };
  return undefined;
}

/** Whether a GitHub token is available, and from where — never the token itself. */
export async function githubTokenStatus(deps: Pick<GithubSourceDeps, "getGhCliToken" | "secrets">): Promise<{ readonly available: boolean; readonly source: GithubTokenSource | null }> {
  const resolved = await resolveGithubToken(deps);
  return { available: resolved !== undefined, source: resolved?.source ?? null };
}

export type GithubSourceRejectionReason = "no_token" | GithubFetchFailureReason | "empty";

export type GithubSourceResult =
  | { readonly ok: true; readonly text: string; readonly repoCount: number }
  | { readonly ok: false; readonly reason: GithubSourceRejectionReason; readonly message: string };

interface GithubRepo {
  readonly name: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly topics: readonly string[];
}

/** Only the fields F4 asks for, from whatever GitHub returned; anything malformed is dropped rather than trusted. */
function parseRepos(json: unknown): GithubRepo[] {
  if (!Array.isArray(json)) return [];
  const repos: GithubRepo[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.full_name !== "string") continue;
    repos.push({
      name: record.name,
      fullName: record.full_name,
      description: typeof record.description === "string" ? record.description : null,
      language: typeof record.language === "string" ? record.language : null,
      topics: Array.isArray(record.topics) ? record.topics.filter((topic): topic is string => typeof topic === "string") : [],
    });
  }
  return repos;
}

/** The README's decoded text (GitHub's contents API answers base64), or "" when it can't be read. */
function decodeReadme(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const record = json as Record<string, unknown>;
  if (typeof record.content !== "string" || record.encoding !== "base64") return "";
  try {
    return Buffer.from(record.content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function composeRepoText(repo: GithubRepo, readme: string): string {
  const lines = [`## ${repo.fullName}`];
  if (repo.description) lines.push(repo.description);
  if (repo.language) lines.push(`Language: ${repo.language}`);
  if (repo.topics.length > 0) lines.push(`Topics: ${repo.topics.join(", ")}`);
  const trimmedReadme = readme.trim();
  if (trimmedReadme) lines.push("", "README:", trimmedReadme);
  return lines.join("\n");
}

/** Default 30: bounds both the composed text's size and how many README calls one import makes. */
const MAX_REPOS = 30;
/** Default 2000 characters: "the README up to a cap." */
const MAX_README_CHARS = 2000;

/** The person's own repositories (owner affiliation only), as one source text. Never throws. */
export async function buildGithubSourceText(deps: GithubSourceDeps): Promise<GithubSourceResult> {
  const resolved = await resolveGithubToken(deps);
  if (!resolved) return { ok: false, reason: "no_token", message: "No GitHub token yet. Sign in with `gh auth login`, or paste a token below." };

  const reposResult = await deps.fetchGithub(`/user/repos?affiliation=owner&per_page=${MAX_REPOS}&sort=updated`, resolved.token);
  if (!reposResult.ok) return { ok: false, reason: reposResult.reason, message: reposResult.message };

  const repos = parseRepos(reposResult.json);
  if (repos.length === 0) return { ok: false, reason: "empty", message: "Your GitHub account has no repositories to import." };

  const parts: string[] = [];
  for (const repo of repos) {
    const readmeResult = await deps.fetchGithub(`/repos/${repo.fullName}/readme`, resolved.token);
    const readme = readmeResult.ok ? decodeReadme(readmeResult.json).slice(0, MAX_README_CHARS) : "";
    parts.push(composeRepoText(repo, readme));
  }
  return { ok: true, text: parts.join("\n\n---\n\n"), repoCount: repos.length };
}
