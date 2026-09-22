import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BudgetStatus, EventsRequest, ScheduleStatus } from "@workflow-catalog/contracts";
import type { Hono } from "hono";
import type { DeviceRecord } from "../store/devices.ts";
import type { RunnerContext } from "./context.ts";

/**
 * Route modules: how later packets add behaviour to the bridge by adding a
 * file, never by editing one. Every `runner/server/routes/<name>.ts` default-
 * exports `defineRouteModule({...})`, and the bridge loads them all at start
 * (sorted by file name). A module can contribute any of:
 *
 *   api(router, ctx)   local-UI JSON routes, mounted at /api/<name>. They sit
 *                      behind the local-UI guard (Host, cookie, same-origin),
 *                      so a handler never re-checks any of that.
 *   events: {...}      the handler for one or more POST /events types. The
 *                      bridge has already authenticated the device, validated
 *                      the body against the contract and journaled it once.
 *                      Exactly one module may handle each type.
 *   status(ctx)        `budget` and/or `schedules` for GET /status.
 *   start(ctx)         runs once when the bridge starts; may return a stop
 *                      function for shutdown (P08's scheduler catch-up).
 *
 * README "Extending the runner" has the table of which packet adds which file.
 */
export const EVENT_TYPES = ["job_capture", "browser_command_result", "application_status_changed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type EventOf<T extends EventType> = Extract<EventsRequest, { type: T }>;

export interface EventContext extends RunnerContext {
  /** The paired device that sent the event (from its bearer token). */
  readonly device: DeviceRecord;
  readonly receivedAt: Date;
}

/**
 * Handles one validated, journaled event. Whatever it returns (JSON-safe) is
 * stored with the journal record and sent back to the extension as `result`.
 * Throw EventRejectedError to refuse the event with a 4xx (for example a stale
 * revision, 409). Any other error is a 500, and the extension's retry of the
 * same eventId runs the handler again.
 */
export type EventHandler<T extends EventType> = (event: EventOf<T>, ctx: EventContext) => unknown;
export type EventHandlers = { readonly [T in EventType]?: EventHandler<T> };

export type EventRejectionStatus = 400 | 403 | 404 | 409 | 410 | 422;

export class EventRejectedError extends Error {
  override readonly name = "EventRejectedError";
  readonly httpStatus: EventRejectionStatus;
  readonly code: string;

  constructor(httpStatus: EventRejectionStatus, code: string, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export interface StatusContribution {
  readonly budget?: BudgetStatus;
  readonly schedules?: readonly ScheduleStatus[];
}

export type StopFunction = () => void | Promise<void>;

export interface RouteModule {
  readonly api?: (router: Hono, ctx: RunnerContext) => void;
  readonly events?: EventHandlers;
  readonly status?: (ctx: RunnerContext) => StatusContribution | Promise<StatusContribution>;
  readonly start?: (ctx: RunnerContext) => void | StopFunction | Promise<void | StopFunction>;
}

/** Identity function that type-checks a route module. */
export function defineRouteModule<const M extends RouteModule>(module: M): M {
  return module;
}

export interface LoadedRouteModule {
  /** The file's base name: `captures` for routes/captures.ts. Its API mounts at /api/<name>. */
  readonly name: string;
  readonly module: RouteModule;
}

export class RouteModuleError extends Error {
  override readonly name = "RouteModuleError";
}

/** A module file name: lowercase letters, digits and hyphens. */
export const ROUTE_MODULE_NAME = /^[a-z][a-z0-9-]*$/;
const MODULE_KEYS = new Set(["api", "events", "status", "start"]);

/** Checks the shape of a module's default export. Throws RouteModuleError naming the file and the problem. */
export function validateRouteModule(name: string, value: unknown): RouteModule {
  const where = `server/routes/${name}.ts`;
  if (!ROUTE_MODULE_NAME.test(name)) throw new RouteModuleError(`${where}: route module names are lowercase letters, digits and hyphens.`);
  if (!value || typeof value !== "object") throw new RouteModuleError(`${where} must \`export default defineRouteModule({ ... })\`.`);
  for (const key of Object.keys(value)) {
    if (!MODULE_KEYS.has(key)) throw new RouteModuleError(`${where}: unknown key "${key}" (allowed: ${[...MODULE_KEYS].join(", ")}).`);
  }
  const candidate = value as Record<string, unknown>;
  for (const key of ["api", "status", "start"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "function") throw new RouteModuleError(`${where}: "${key}" must be a function.`);
  }
  if (candidate.events !== undefined) {
    if (!candidate.events || typeof candidate.events !== "object") throw new RouteModuleError(`${where}: "events" must be an object.`);
    for (const [type, handler] of Object.entries(candidate.events)) {
      if (!(EVENT_TYPES as readonly string[]).includes(type)) {
        throw new RouteModuleError(`${where}: "${type}" is not a bridge event type (${EVENT_TYPES.join(", ")}).`);
      }
      if (typeof handler !== "function") throw new RouteModuleError(`${where}: the "${type}" handler must be a function.`);
    }
  }
  return value as RouteModule;
}

/**
 * Loads every route module in `dir`: `*.ts` files, skipping tests
 * (`*.test.ts`), type declarations and names starting with `_` or `.`.
 */
export async function loadRouteModules(dir: string): Promise<LoadedRouteModule[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = names
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts") && !/^[_.]/.test(file))
    .sort();
  const loaded: LoadedRouteModule[] = [];
  for (const file of files) {
    const name = file.slice(0, -".ts".length);
    const imported = (await import(pathToFileURL(path.join(dir, file)).href)) as { default?: unknown };
    loaded.push({ name, module: validateRouteModule(name, imported.default) });
  }
  return loaded;
}

export interface RegisteredHandler {
  readonly module: string;
  readonly handle: (event: EventsRequest, ctx: EventContext) => unknown;
}

/** One handler per event type. Two modules claiming one type is a startup error. */
export function buildEventRegistry(modules: readonly LoadedRouteModule[]): ReadonlyMap<EventType, RegisteredHandler> {
  const registry = new Map<EventType, RegisteredHandler>();
  for (const { name, module } of modules) {
    for (const type of EVENT_TYPES) {
      const handle = module.events?.[type];
      if (!handle) continue;
      const existing = registry.get(type);
      if (existing) {
        throw new RouteModuleError(`Both server/routes/${existing.module}.ts and server/routes/${name}.ts handle "${type}" events. Exactly one module may.`);
      }
      registry.set(type, { module: name, handle: handle as RegisteredHandler["handle"] });
    }
  }
  return registry;
}
