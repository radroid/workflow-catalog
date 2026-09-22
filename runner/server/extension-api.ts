import {
  commandsResponseSchema,
  eventsRequestSchema,
  isoDateTimeSchema,
  MAX_BRIDGE_BODY_BYTES,
  pairRequestSchema,
  pairResponseSchema,
  statusResponseSchema,
  type BudgetStatus,
  type ScheduleStatus,
} from "@workflow-catalog/contracts";
import { Hono } from "hono";
import { MINUTE_MS } from "../lib/clock.ts";
import { EXTENSION_ORIGIN_PATTERN, type DeviceRecord } from "../store/devices.ts";
import type { RunnerContext } from "./context.ts";
import { EventsPipeline } from "./events.ts";
import { declaredLengthExceeds, errorResponse, jsonResponse, readBoundedJson, validationErrorResponse } from "./http.ts";
import { buildEventRegistry, type LoadedRouteModule } from "./route-modules.ts";

/**
 * The extension-facing bridge (mvp-spec §5), exactly four routes:
 *
 *   POST /pair       { code } → { deviceId, token }
 *   GET  /commands   ?since=<ISO datetime>, device-scoped, leased
 *   POST /events     job_capture | browser_command_result | application_status_changed
 *   GET  /status     { version, workspaceId, budget, schedules }
 *
 * Checks, in order (the first that fails answers):
 *   Host (app.ts) → route (404) → declared Content-Length over 256 KiB (413)
 *   → bearer token (401) → Origin (403) → Content-Type application/json (415)
 *   → streamed body over 256 KiB (413) → JSON and zod contract (400, with
 *   every issue's path).
 * The Origin rule follows what Chrome sends (Chromium 153, measured from an
 * extension page, its service worker and an alarm-driven fetch): no Origin
 * on an extension's GET, `Origin: chrome-extension://<id>` on its POST.
 *   - GET or HEAD with no Origin: accepted on the device token alone.
 *   - Any Origin that is present must be the device's paired origin.
 *   - POST must carry the paired origin.
 * /pair has no token yet: its Origin must be a chrome-extension:// origin,
 * which becomes the device's origin.
 *
 * CORS is not authentication (§5): these headers only let the paired
 * extension's pages read responses. Every request is still authenticated.
 */
export const PAIR_FAILURE_LIMIT = 10;
export const PAIR_FAILURE_WINDOW_MS = 10 * MINUTE_MS;

const CORS_ALLOW_HEADERS = "authorization, content-type";
const CORS_MAX_AGE_S = "600";
const BEARER = /^Bearer ([A-Za-z0-9_-]{1,512})$/;
/** Methods that only read: HEAD is answered by the GET routes. */
const READ_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_BUDGET: BudgetStatus = { dailyRunLimit: 0, runsUsedToday: 0, paused: false };

export interface ExtensionApiOptions {
  readonly ctx: RunnerContext;
  readonly modules: readonly LoadedRouteModule[];
}

/**
 * Wrong codes one pairing code may absorb, from all origins together, before
 * it is withdrawn. The per-origin window below is only for fairness: a local
 * process can send any extension origin it likes, so the window alone would
 * give it 10 guesses per made-up origin. This budget is what bounds guessing.
 */
export const PAIR_CODE_GUESS_BUDGET = 100;

/** Most origins the per-origin window tracks at once; past it, the oldest is forgotten. That only affects fairness, never the budget. */
const PAIR_THROTTLE_MAX_ORIGINS = 1_000;

/**
 * Wrong pairing codes, counted two ways.
 * - Per origin, in a sliding 10-minute window, so one extension's wrong codes
 *   never lock another out. An origin at the limit gets 429 without its code
 *   being checked, so each origin holds at most PAIR_FAILURE_LIMIT timestamps.
 * - For all origins together: the times of the last PAIR_CODE_GUESS_BUDGET
 *   wrong codes. A code issued at or before the oldest of them has absorbed
 *   the whole budget and is withdrawn (see /pair). A code issued later starts
 *   with a fresh budget, whichever process issued it.
 */
class PairThrottle {
  readonly #failures = new Map<string, number[]>();
  readonly #wrongCodes: number[] = [];
  readonly #ctx: RunnerContext;

  constructor(ctx: RunnerContext) {
    this.#ctx = ctx;
  }

  /**
   * Records a wrong code against every outstanding code. Returns the instant
   * from which the last PAIR_CODE_GUESS_BUDGET wrong codes were tried: every
   * code issued at or before it has absorbed the whole budget. Undefined while
   * fewer have been tried.
   */
  wrongCode(): Date | undefined {
    this.#wrongCodes.push(this.#ctx.clock.now().getTime());
    if (this.#wrongCodes.length > PAIR_CODE_GUESS_BUDGET) this.#wrongCodes.shift();
    return this.#wrongCodes.length >= PAIR_CODE_GUESS_BUDGET ? new Date(this.#wrongCodes[0] ?? 0) : undefined;
  }

  #prune(now: number): void {
    for (const [origin, times] of this.#failures) {
      while (times.length > 0 && (times[0] ?? 0) <= now - PAIR_FAILURE_WINDOW_MS) times.shift();
      if (times.length === 0) this.#failures.delete(origin);
    }
  }

  /** Seconds `origin` must wait, or 0 when it may try a code. */
  retryAfterSeconds(origin: string): number {
    const now = this.#ctx.clock.now().getTime();
    this.#prune(now);
    const times = this.#failures.get(origin) ?? [];
    if (times.length < PAIR_FAILURE_LIMIT) return 0;
    return Math.max(1, Math.ceil(((times[0] ?? now) + PAIR_FAILURE_WINDOW_MS - now) / 1000));
  }

  fail(origin: string): void {
    const times = this.#failures.get(origin) ?? [];
    times.push(this.#ctx.clock.now().getTime());
    this.#failures.delete(origin);
    this.#failures.set(origin, times);
    if (this.#failures.size > PAIR_THROTTLE_MAX_ORIGINS) {
      const oldest = this.#failures.keys().next().value;
      if (oldest !== undefined) this.#failures.delete(oldest);
    }
  }
}

function corsHeaders(origin: string, methods: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": `${methods}, OPTIONS`,
    "access-control-allow-headers": CORS_ALLOW_HEADERS,
    "access-control-max-age": CORS_MAX_AGE_S,
    vary: "Origin",
  };
}

function responseCors(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

export function extensionApi(options: ExtensionApiOptions): Hono {
  const { ctx, modules } = options;
  const pipeline = new EventsPipeline(ctx, buildEventRegistry(modules));
  const throttle = new PairThrottle(ctx);
  const app = new Hono();

  /** CORS headers for a response to `origin`, when that origin belongs to an active paired device. */
  async function deviceCors(origin: string | null): Promise<Record<string, string>> {
    if (!origin || !EXTENSION_ORIGIN_PATTERN.test(origin)) return {};
    const active = await ctx.devices.active();
    return active.some((device) => device.origin === origin) ? responseCors(origin) : {};
  }

  type Authed = { ok: true; device: DeviceRecord; cors: Record<string, string> } | { ok: false; response: Response };

  /** Declared size, bearer token, then Origin. */
  async function authenticate(request: Request): Promise<Authed> {
    const origin = request.headers.get("origin");
    const cors = await deviceCors(origin);
    if (declaredLengthExceeds(request, MAX_BRIDGE_BODY_BYTES)) {
      return { ok: false, response: errorResponse(413, "body_too_large", `Request body is larger than ${MAX_BRIDGE_BODY_BYTES} bytes.`, cors) };
    }
    const header = request.headers.get("authorization");
    const challenge = { ...cors, "www-authenticate": 'Bearer realm="workflow-catalog-runner"' };
    if (!header) return { ok: false, response: errorResponse(401, "token_missing", "Send the device token as `Authorization: Bearer <token>`.", challenge) };
    const token = BEARER.exec(header)?.[1];
    const device = token ? await ctx.devices.authenticate(token) : undefined;
    if (!device) {
      return {
        ok: false,
        response: errorResponse(401, "token_invalid", "This device token is not valid (unknown, revoked or expired). Pair the extension again.", challenge),
      };
    }
    if (origin === null) {
      // Chrome sends no Origin on an extension's GET, so the token alone
      // authenticates a read. Anything that changes state must say where it
      // comes from.
      if (!READ_METHODS.has(request.method)) {
        return { ok: false, response: errorResponse(403, "origin_required", "Send this request with the Origin of the extension this device paired from.") };
      }
    } else if (origin !== device.origin) {
      return { ok: false, response: errorResponse(403, "origin_not_allowed", "This request's Origin is not the extension origin this device paired from.", cors) };
    }
    return { ok: true, device, cors };
  }

  /** Refuses any query parameter other than `allowed`. */
  function unexpectedQuery(url: URL, allowed: readonly string[], cors: Record<string, string>): Response | undefined {
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key)) {
        return jsonResponse(
          400,
          { ok: false, error: { code: "invalid_query", message: `Unknown query parameter "${key}".`, issues: [{ path: [key], message: "Unknown query parameter." }] } },
          cors,
        );
      }
    }
    return undefined;
  }

  // Preflight. /pair may come from any extension origin (it is not paired yet);
  // the other routes only from the origin of an active paired device.
  app.options("/pair", (c) => {
    const origin = c.req.header("origin");
    if (!origin || !EXTENSION_ORIGIN_PATTERN.test(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin, "POST") });
  });
  for (const [route, method] of [
    ["/commands", "GET"],
    ["/events", "POST"],
    ["/status", "GET"],
  ] as const) {
    app.options(route, async (c) => {
      const origin = c.req.header("origin") ?? null;
      const cors = await deviceCors(origin);
      if (!origin || !cors["access-control-allow-origin"]) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin, method) });
    });
  }

  app.post("/pair", async (c) => {
    const request = c.req.raw;
    const origin = request.headers.get("origin");
    if (!origin || !EXTENSION_ORIGIN_PATTERN.test(origin)) {
      return errorResponse(403, "origin_not_allowed", "Pairing is only accepted from a Chrome extension (Origin chrome-extension://<id>).");
    }
    const cors = responseCors(origin);
    const retryAfter = throttle.retryAfterSeconds(origin);
    if (retryAfter > 0) {
      return errorResponse(429, "too_many_attempts", "Too many wrong pairing codes. Wait, then issue a new code with `npm run pair`.", {
        ...cors,
        "retry-after": String(retryAfter),
      });
    }
    const body = await readBoundedJson(request, MAX_BRIDGE_BODY_BYTES, cors);
    if (!body.ok) return body.response;
    const parsed = pairRequestSchema.safeParse(body.value);
    if (!parsed.success) return validationErrorResponse(parsed.error, cors);
    const redeemed = await ctx.pairing.redeem(parsed.data.code);
    if (redeemed !== "ok") {
      throttle.fail(origin);
      if (redeemed === "expired") {
        return errorResponse(401, "pairing_code_expired", "This pairing code has expired (codes last 10 minutes). Run `npm run pair` for a new one.", cors);
      }
      // A wrong code is a guess at every outstanding code. Withdraw each code
      // that has now absorbed the whole budget.
      const spentSince = throttle.wrongCode();
      if (spentSince) {
        const revoked = await ctx.pairing.revokeIssuedAtOrBefore(spentSince);
        if (revoked > 0) ctx.log.warn(`Withdrew ${revoked} pairing code(s) after ${PAIR_CODE_GUESS_BUDGET} wrong codes. \`npm run pair\` issues a new one.`);
      }
      return errorResponse(
        401,
        "pairing_code_invalid",
        "This pairing code is not valid: it is wrong, was already used, or was withdrawn after too many wrong tries. Run `npm run pair` for a new one.",
        cors,
      );
    }
    const { device, token } = await ctx.devices.register(origin);
    ctx.log.info(`Paired device ${device.deviceId} (${origin}).`);
    return jsonResponse(200, pairResponseSchema.parse({ deviceId: device.deviceId, token }), cors);
  });

  app.get("/commands", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const url = new URL(c.req.url);
    const bad = unexpectedQuery(url, ["since"], auth.cors);
    if (bad) return bad;
    const sinceValues = url.searchParams.getAll("since");
    let since: Date | undefined;
    if (sinceValues.length > 0) {
      const parsed = sinceValues.length === 1 ? isoDateTimeSchema.safeParse(sinceValues[0]) : undefined;
      if (!parsed?.success) {
        return jsonResponse(
          400,
          {
            ok: false,
            error: {
              code: "invalid_query",
              message: "`since` must be one ISO 8601 date-time with an offset, e.g. 2026-09-22T09:00:00.000Z.",
              issues: [{ path: ["since"], message: parsed?.error.issues[0]?.message ?? "Give `since` at most once." }],
            },
          },
          auth.cors,
        );
      }
      since = new Date(parsed.data);
    }
    const commands = await ctx.commands.leasePending(auth.device.deviceId, since ? { since } : {});
    return jsonResponse(200, commandsResponseSchema.parse({ commands }), auth.cors);
  });

  app.post("/events", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const body = await readBoundedJson(c.req.raw, MAX_BRIDGE_BODY_BYTES, auth.cors);
    if (!body.ok) return body.response;
    const parsed = eventsRequestSchema.safeParse(body.value);
    if (!parsed.success) return validationErrorResponse(parsed.error, auth.cors);
    const outcome = await pipeline.submit(parsed.data, auth.device);
    return jsonResponse(outcome.status, outcome.body, auth.cors);
  });

  app.get("/status", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return auth.response;
    const bad = unexpectedQuery(new URL(c.req.url), [], auth.cors);
    if (bad) return bad;
    let budget: BudgetStatus | undefined;
    const schedules: ScheduleStatus[] = [];
    for (const { name, module } of modules) {
      if (!module.status) continue;
      const contribution = await module.status(ctx);
      if (contribution.budget) {
        if (budget) ctx.log.warn(`server/routes/${name}.ts also reports a budget; the first module's budget is used.`);
        else budget = contribution.budget;
      }
      if (contribution.schedules) schedules.push(...contribution.schedules);
    }
    const status = statusResponseSchema.safeParse({
      version: ctx.packageVersion,
      workspaceId: ctx.workspace.manifest.workspaceId,
      budget: budget ?? DEFAULT_BUDGET,
      schedules,
    });
    if (!status.success) {
      ctx.log.error(`GET /status does not match the contract: ${status.error.issues[0]?.path.join(".")}: ${status.error.issues[0]?.message}`);
      return errorResponse(500, "status_invalid", "The runner's status did not match the contract.", auth.cors);
    }
    return jsonResponse(200, status.data, auth.cors);
  });

  return app;
}
