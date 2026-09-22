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
 *   → bearer token (401) → Origin equals the device's paired origin (403)
 *   → Content-Type application/json (415) → streamed body over 256 KiB (413)
 *   → JSON and zod contract (400, with every issue's path).
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
const DEFAULT_BUDGET: BudgetStatus = { dailyRunLimit: 0, runsUsedToday: 0, paused: false };

export interface ExtensionApiOptions {
  readonly ctx: RunnerContext;
  readonly modules: readonly LoadedRouteModule[];
}

/** Failed pairing attempts in a sliding window, for all origins together. */
class PairThrottle {
  readonly #failures: number[] = [];
  readonly #ctx: RunnerContext;

  constructor(ctx: RunnerContext) {
    this.#ctx = ctx;
  }

  #prune(now: number): void {
    while (this.#failures.length > 0 && (this.#failures[0] ?? 0) <= now - PAIR_FAILURE_WINDOW_MS) this.#failures.shift();
  }

  /** Seconds to wait, or 0 when attempts are allowed. */
  retryAfterSeconds(): number {
    const now = this.#ctx.clock.now().getTime();
    this.#prune(now);
    if (this.#failures.length < PAIR_FAILURE_LIMIT) return 0;
    return Math.max(1, Math.ceil(((this.#failures[0] ?? now) + PAIR_FAILURE_WINDOW_MS - now) / 1000));
  }

  fail(): void {
    this.#failures.push(this.#ctx.clock.now().getTime());
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
    if (origin !== device.origin) {
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
    const retryAfter = throttle.retryAfterSeconds();
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
      throttle.fail();
      return redeemed === "expired"
        ? errorResponse(401, "pairing_code_expired", "This pairing code has expired (codes last 10 minutes). Run `npm run pair` for a new one.", cors)
        : errorResponse(401, "pairing_code_invalid", "This pairing code is not valid or was already used. Run `npm run pair` for a new one.", cors);
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
