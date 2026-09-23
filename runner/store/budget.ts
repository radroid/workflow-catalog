import { z } from "zod";
import { budgetStatusSchema, isoDateTimeSchema, type BudgetStatus } from "@workflow-catalog/contracts";
import type { Clock } from "../lib/clock.ts";
import { countCountableRuns, localDateString } from "./runs.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The daily run budget and its pause (F11, hard-problems #7), persisted at
 * `runs/budget.json` (mvp-spec §5 / ARCHITECTURE §4). `runsUsedToday` is
 * never stored here: it is always derived from today's run log
 * (`store/runs.ts`'s `countCountableRuns`), so it can never drift from the
 * log and a new local day needs no explicit "reset" — it is just a new,
 * empty `runs/<date>/` directory.
 *
 * Decision 2 (corrupt file): a *missing* file gives the defaults. A file
 * that is *present but invalid* (malformed JSON, or JSON that fails the
 * schema) fails closed: `getBudgetState`/`getBudgetStatus` report it as
 * paused, with reason `CORRUPT_BUDGET_REASON`, without ever throwing. The
 * bad file on disk is left alone until something writes a fresh one
 * (`setBudgetLimits`, `resumeBudget`, or an internal `pauseBudget` call) —
 * reading never repairs it, so a person's actual bytes are never
 * overwritten by a read.
 *
 * I2 (round-2 escalation): `getBudgetState` never throws. When today's
 * `runs/<date>/` exists but can't be listed, the count is unknown, so the
 * state is a synthetic pause with the fixed reason `run log unreadable
 * (runs/<date>/)` (`runLogUnreadableReason`). Like the corrupt-file pause it
 * is derived on every read and never stored, so it clears by itself once the
 * folder can be read again; Resume can't clear it (`pauseKind`
 * `"run_log_unreadable"` tells the UI so).
 *
 * Which pause is reported when more than one applies, first match wins:
 *   1. `budget_unreadable`  the file is unreadable now (synthetic; limits shown are the defaults)
 *   2. `budget_repaired`    a Save rewrote an unreadable file; paused until Resume (stored)
 *   3. `stored`             any other stored pause, e.g. "provider limit" (stored)
 *   4. `run_log_unreadable` today's run folder can't be listed (synthetic)
 */

export const DAILY_RUN_LIMIT_MIN = 1;
export const DAILY_RUN_LIMIT_MAX = 50;
export const ITEM_CAP_MIN = 1;
export const ITEM_CAP_MAX = 20;
export const DEFAULT_DAILY_RUN_LIMIT = 10;
export const DEFAULT_ITEM_CAP = 5;

export const CORRUPT_BUDGET_REASON = "budget settings unreadable (runs/budget.json)";

/**
 * The reason a Save stores when it rewrites an unreadable file (I4, UI critic issue 2). Decision 2 keeps the pause
 * until Resume, but "unreadable" stops being true the moment Save writes a valid file, so the stored reason says
 * what happened instead. `GET /status` carries it to the board and the extension as well.
 */
export const REPAIRED_BUDGET_REASON = "budget settings were unreadable (runs/budget.json)";

/** I2: the fixed reason for the synthetic pause when today's run folder can't be listed. */
export function runLogUnreadableReason(date: string): string {
  return `run log unreadable (runs/${date}/)`;
}

/**
 * I2: what `routes/runs.ts`'s `status()` reports if computing the budget ever fails. `getBudgetState` is built
 * never to throw, so this is belt and braces for `GET /status` (whose handler, in extension-api.ts, has no catch
 * of its own): fail closed, as a pause the extension and the board can show, rather than a 500.
 */
export const BUDGET_UNAVAILABLE_REASON = "budget status unavailable";

/** Which pause `getBudgetState` is reporting; see the precedence list at the top of this file. */
export type PauseKind = "budget_unreadable" | "budget_repaired" | "stored" | "run_log_unreadable";

const SEGMENTS = ["runs", "budget.json"] as const;

/**
 * G4 (round-1 revision, reviewer issue 5): one in-process promise chain per
 * workspace, so every budget-file read-modify-write (`pauseBudget`,
 * `resumeBudget`, `setBudgetLimits`, and `run-harness.ts`'s `withRun`
 * refusal check + `startRun`) is fully serialized. Without this, a Save
 * racing a provider-limit pause could read-before-write past each other and
 * silently lose one of the two (reproduced 15/40 trials in the round-1
 * review's probe). A `WeakMap` keyed by the `Workspace` instance: no cross-
 * test leakage, and correct for the one workspace a real runner process
 * ever has. Purely in-memory — irrelevant across separate processes, but
 * there is only ever one runner process per workspace.
 */
const budgetLocks = new WeakMap<Workspace, Promise<void>>();

export function withBudgetLock<T>(workspace: Workspace, fn: () => Promise<T>): Promise<T> {
  const tail = budgetLocks.get(workspace) ?? Promise.resolve();
  const result = tail.then(fn, fn);
  budgetLocks.set(
    workspace,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

const budgetFileSchema = z
  .object({
    dailyRunLimit: z.number().int().min(DAILY_RUN_LIMIT_MIN).max(DAILY_RUN_LIMIT_MAX),
    itemCap: z.number().int().min(ITEM_CAP_MIN).max(ITEM_CAP_MAX),
    paused: z.boolean(),
    /** Present exactly when `paused` is true and the pause came from a real (non-corrupt) write. */
    pausedReason: z.string().min(1).optional(),
    pausedSince: isoDateTimeSchema.optional(),
  })
  .strict();
export type BudgetFile = z.infer<typeof budgetFileSchema>;

export const DEFAULT_BUDGET_FILE: BudgetFile = {
  dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT,
  itemCap: DEFAULT_ITEM_CAP,
  paused: false,
};

/** The full, internal budget state: the file's fields plus the derived usage count. Settings reads this; the wire `BudgetStatus` (below) is a subset. */
export interface BudgetState {
  readonly dailyRunLimit: number;
  readonly itemCap: number;
  /** Today's countable runs. 0 when `runLogUnreadable` (the count is unknown; the synthetic pause says why). */
  readonly runsUsedToday: number;
  readonly paused: boolean;
  readonly pausedReason?: string;
  readonly pausedSince?: string;
  /** Present exactly when `paused` is true. */
  readonly pauseKind?: PauseKind;
  /** True when `runs/budget.json` exists but failed to parse: the pause above is synthetic (decision 2), not a stored field. */
  readonly corrupt: boolean;
  /** True when today's `runs/<date>/` exists but can't be listed (I2), so `runsUsedToday` is unknown. */
  readonly runLogUnreadable: boolean;
}

type ReadResult = { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "ok"; readonly file: BudgetFile };

/** Never throws: a malformed-JSON or schema-invalid file both come back `"invalid"`. */
async function readBudgetFile(workspace: Workspace): Promise<ReadResult> {
  let raw: unknown;
  try {
    raw = await workspace.readJson(...SEGMENTS);
  } catch {
    return { kind: "invalid" };
  }
  if (raw === undefined) return { kind: "missing" };
  const parsed = budgetFileSchema.safeParse(raw);
  return parsed.success ? { kind: "ok", file: parsed.data } : { kind: "invalid" };
}

async function writeBudgetFile(workspace: Workspace, file: BudgetFile): Promise<void> {
  await workspace.writeJson(SEGMENTS, budgetFileSchema.parse(file));
}

/** The existing limits to carry forward into a rewrite: a valid file's own limits, else the defaults (nothing usable survives a missing or corrupt file). */
function existingLimits(result: ReadResult): Pick<BudgetFile, "dailyRunLimit" | "itemCap"> {
  return result.kind === "ok" ? { dailyRunLimit: result.file.dailyRunLimit, itemCap: result.file.itemCap } : { dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP };
}

/** A stored pause whose reason names the corrupt-file recovery (the current wording, or the older one a previous Save stored). */
function isRepairedReason(reason: string | undefined): boolean {
  return reason === REPAIRED_BUDGET_REASON || reason === CORRUPT_BUDGET_REASON;
}

/**
 * The full internal state: file (or its defaults/corrupt fallback) plus today's derived usage. Never throws (I2):
 * `readBudgetFile` catches every read error itself, and an unlistable run folder for today becomes the synthetic
 * "run log unreadable" pause below instead of a rejection.
 */
export async function getBudgetState(workspace: Workspace, clock: Clock): Promise<BudgetState> {
  const today = localDateString(clock.now());
  const result = await readBudgetFile(workspace);
  let runsUsedToday = 0;
  let runLogUnreadable = false;
  try {
    runsUsedToday = await countCountableRuns(workspace, today);
  } catch {
    runLogUnreadable = true;
  }

  if (result.kind === "invalid") {
    return {
      dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT,
      itemCap: DEFAULT_ITEM_CAP,
      runsUsedToday,
      paused: true,
      pausedReason: CORRUPT_BUDGET_REASON,
      pauseKind: "budget_unreadable",
      corrupt: true,
      runLogUnreadable,
    };
  }
  const file = result.kind === "ok" ? result.file : DEFAULT_BUDGET_FILE;
  const limits = { dailyRunLimit: file.dailyRunLimit, itemCap: file.itemCap, runsUsedToday };
  if (file.paused) {
    return {
      ...limits,
      paused: true,
      ...(file.pausedReason !== undefined ? { pausedReason: file.pausedReason } : {}),
      ...(file.pausedSince !== undefined ? { pausedSince: file.pausedSince } : {}),
      pauseKind: isRepairedReason(file.pausedReason) ? "budget_repaired" : "stored",
      corrupt: false,
      runLogUnreadable,
    };
  }
  if (runLogUnreadable) {
    return { ...limits, paused: true, pausedReason: runLogUnreadableReason(today), pauseKind: "run_log_unreadable", corrupt: false, runLogUnreadable };
  }
  return { ...limits, paused: false, corrupt: false, runLogUnreadable };
}

/** The wire shape (`bridge-http.ts`'s `budgetStatusSchema`): `GET /status` and `GET /api/runs/budget` both derive from this. */
export async function getBudgetStatus(workspace: Workspace, clock: Clock): Promise<BudgetStatus> {
  const state = await getBudgetState(workspace, clock);
  return budgetStatusSchema.parse({
    dailyRunLimit: state.dailyRunLimit,
    runsUsedToday: state.runsUsedToday,
    paused: state.paused,
    ...(state.pausedReason !== undefined ? { pausedReason: state.pausedReason } : {}),
  });
}

/**
 * Sets the pause (called by `run-harness.ts` on a detected provider limit, or
 * a future manual-pause action). Preserves the existing limits; a corrupt
 * file's limits cannot be preserved; a missing one has none yet.
 */
export async function pauseBudget(workspace: Workspace, clock: Clock, reason: string): Promise<void> {
  await withBudgetLock(workspace, async () => {
    const result = await readBudgetFile(workspace);
    await writeBudgetFile(workspace, { ...existingLimits(result), paused: true, pausedReason: reason, pausedSince: clock.now().toISOString() });
  });
}

export interface ResumeResult {
  /**
   * True when `runs/budget.json` was unreadable at the moment of Resume, so Resume wrote the default limits
   * (decision 2). The Settings message mentions the defaults only then (I4); a file that a Save already repaired
   * keeps the person's saved limits.
   */
  readonly restoredDefaults: boolean;
}

/**
 * Clears the stored pause. Recovering from a corrupt file has nothing to
 * restore, so it writes the default limits (decision 2, "Resume rewrites a
 * valid file with the default limits, unpaused"); recovering from a real,
 * readable pause keeps whatever limits were already set. The synthetic
 * "run log unreadable" pause is never stored, so Resume can't clear it.
 */
export async function resumeBudget(workspace: Workspace): Promise<ResumeResult> {
  return withBudgetLock(workspace, async () => {
    const result = await readBudgetFile(workspace);
    await writeBudgetFile(workspace, { ...existingLimits(result), paused: false });
    return { restoredDefaults: result.kind === "invalid" };
  });
}

export interface SetBudgetLimitsInput {
  readonly dailyRunLimit: number;
  readonly itemCap: number;
}

/**
 * Saves new limits. Decision 2: "Save ... keeps the pause until Resume" — an
 * existing pause (real or the synthetic corrupt-file one) is preserved; only
 * `resumeBudget` clears it. This also doubles as the repair path for a
 * corrupt file: Save always writes a schema-valid file, whatever state the
 * old one was in. A Save that repairs an unreadable file keeps it paused
 * with `REPAIRED_BUDGET_REASON`, since the file is readable from then on.
 */
export async function setBudgetLimits(workspace: Workspace, input: SetBudgetLimitsInput): Promise<void> {
  await withBudgetLock(workspace, async () => {
    const result = await readBudgetFile(workspace);
    const pause: Pick<BudgetFile, "paused" | "pausedReason" | "pausedSince"> =
      result.kind === "ok"
        ? { paused: result.file.paused, ...(result.file.pausedReason !== undefined ? { pausedReason: result.file.pausedReason } : {}), ...(result.file.pausedSince !== undefined ? { pausedSince: result.file.pausedSince } : {}) }
        : result.kind === "invalid"
          ? { paused: true, pausedReason: REPAIRED_BUDGET_REASON }
          : { paused: false };
    await writeBudgetFile(workspace, { dailyRunLimit: input.dailyRunLimit, itemCap: input.itemCap, ...pause });
  });
}
