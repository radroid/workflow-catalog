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
 */

export const DAILY_RUN_LIMIT_MIN = 1;
export const DAILY_RUN_LIMIT_MAX = 50;
export const ITEM_CAP_MIN = 1;
export const ITEM_CAP_MAX = 20;
export const DEFAULT_DAILY_RUN_LIMIT = 10;
export const DEFAULT_ITEM_CAP = 5;

export const CORRUPT_BUDGET_REASON = "budget settings unreadable (runs/budget.json)";

const SEGMENTS = ["runs", "budget.json"] as const;

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
  readonly runsUsedToday: number;
  readonly paused: boolean;
  readonly pausedReason?: string;
  readonly pausedSince?: string;
  /** True when `runs/budget.json` exists but failed to parse: the pause above is synthetic (decision 2), not a stored field. */
  readonly corrupt: boolean;
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

/** The full internal state: file (or its defaults/corrupt fallback) plus today's derived usage. Never throws. */
export async function getBudgetState(workspace: Workspace, clock: Clock): Promise<BudgetState> {
  const result = await readBudgetFile(workspace);
  const runsUsedToday = await countCountableRuns(workspace, localDateString(clock.now()));
  if (result.kind === "invalid") {
    return { dailyRunLimit: DEFAULT_DAILY_RUN_LIMIT, itemCap: DEFAULT_ITEM_CAP, runsUsedToday, paused: true, pausedReason: CORRUPT_BUDGET_REASON, corrupt: true };
  }
  const file = result.kind === "ok" ? result.file : DEFAULT_BUDGET_FILE;
  return {
    dailyRunLimit: file.dailyRunLimit,
    itemCap: file.itemCap,
    runsUsedToday,
    paused: file.paused,
    ...(file.pausedReason !== undefined ? { pausedReason: file.pausedReason } : {}),
    ...(file.pausedSince !== undefined ? { pausedSince: file.pausedSince } : {}),
    corrupt: false,
  };
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
  const result = await readBudgetFile(workspace);
  await writeBudgetFile(workspace, { ...existingLimits(result), paused: true, pausedReason: reason, pausedSince: clock.now().toISOString() });
}

/**
 * Clears the pause. Recovering from a corrupt file has nothing to restore,
 * so it writes the default limits (decision 2, "Resume rewrites a valid
 * file with the default limits, unpaused"); recovering from a real,
 * readable pause keeps whatever limits were already set.
 */
export async function resumeBudget(workspace: Workspace): Promise<void> {
  const result = await readBudgetFile(workspace);
  await writeBudgetFile(workspace, { ...existingLimits(result), paused: false });
}

export interface SetBudgetLimitsInput {
  readonly dailyRunLimit: number;
  readonly itemCap: number;
}

/**
 * Saves new limits. Decision 2: "Save ... keeps the pause until Resume" — an
 * existing pause (real or the synthetic corrupt-file one) is preserved
 * as-is; only `resumeBudget` clears it. This also doubles as the repair path
 * for a corrupt file: Save always writes a schema-valid file, whatever state
 * the old one was in.
 */
export async function setBudgetLimits(workspace: Workspace, input: SetBudgetLimitsInput): Promise<void> {
  const result = await readBudgetFile(workspace);
  const pause: Pick<BudgetFile, "paused" | "pausedReason" | "pausedSince"> =
    result.kind === "ok"
      ? { paused: result.file.paused, ...(result.file.pausedReason !== undefined ? { pausedReason: result.file.pausedReason } : {}), ...(result.file.pausedSince !== undefined ? { pausedSince: result.file.pausedSince } : {}) }
      : result.kind === "invalid"
        ? { paused: true, pausedReason: CORRUPT_BUDGET_REASON }
        : { paused: false };
  await writeBudgetFile(workspace, { dailyRunLimit: input.dailyRunLimit, itemCap: input.itemCap, ...pause });
}
