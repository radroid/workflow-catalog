import { uuidSchema } from "@workflow-catalog/contracts";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";
import { REQUIREMENT_STATUSES } from "../../store/applications.ts";
import { coverLetterDraftSchema, draftSchema, resumeDraftSchema } from "../../validate/draft-schema.ts";

/**
 * `prepare_application`'s input/output shape and description, and the
 * readers the bridge uses on a finished turn's events (P05). Directive-free,
 * so both tool roots (`agent/` and `eval-agent/agent/`), the applications
 * route and the eval import it (docs/spec/research/eve-runtime.md §8 item
 * 14).
 *
 * Model tools take IDs only (iter-003 decision): the model passes the
 * application's `taskId`, never a URL, a path, a claim's text or the
 * posting's. The tool reads the preparation the bridge started for that
 * application (the claims, by label, and the job snapshot) from the stores.
 * What the model does pass is its own work: how each requirement is met,
 * and the draft, whose every sentence cites claim labels like `[C1]`.
 *
 * The tool checks and returns; it never writes. The bridge exports and
 * saves the documents after the turn ends ok, from this call's result
 * (`preparationResult`), and only after checking the draft again itself.
 */

export const PREPARE_APPLICATION_TOOL = "prepare_application";

/** The only tools a preparation turn may use: this one, and loading its skills. Any other call means nothing is saved. */
export const PREPARATION_TOOL_NAMES: readonly string[] = [PREPARE_APPLICATION_TOOL, "load_skill"];

const labelSchema = z.string().regex(/^C\d{1,4}$/);

export const requirementEntrySchema = z
  .object({
    requirement: z.number().int().positive(),
    status: z.enum(REQUIREMENT_STATUSES),
    /** For `covered`: the labels of the confirmed claims that meet it. */
    claims: z.array(labelSchema).max(12).optional(),
    /** For `gap`: one short question for the person. */
    question: z.string().min(1).max(300).optional(),
  })
  .strict();

export const prepareApplicationInputSchema = z
  .object({
    taskId: uuidSchema,
    requirements: z.array(requirementEntrySchema).max(60),
    resume: resumeDraftSchema.optional(),
    coverLetter: coverLetterDraftSchema.optional(),
  })
  .strict();
export type PrepareApplicationInput = z.infer<typeof prepareApplicationInputSchema>;

export const coverageEntrySchema = z.object({ requirement: z.number().int().positive(), status: z.enum(REQUIREMENT_STATUSES), labels: z.array(z.string()) }).strict();

export const prepareApplicationOutputSchema = z
  .object({
    taskId: uuidSchema,
    /** The preparation attempt this answer belongs to; absent when there was none to check against. */
    attemptId: uuidSchema.optional(),
    /** accepted: the draft passed; questions: the person must answer gaps first; refused: fix what `problems` names and call again. */
    status: z.enum(["accepted", "questions", "refused"]),
    message: z.string(),
    /** Each problem: the validator rule it broke (or `requirements`), where, the sentence, and what to fix. */
    problems: z.array(z.object({ rule: z.string(), where: z.string(), sentence: z.string(), message: z.string() }).strict()).optional(),
    questions: z.array(z.object({ requirement: z.number().int().positive(), question: z.string() }).strict()).optional(),
    coverage: z.array(coverageEntrySchema).optional(),
    /** The accepted draft, with its citations: present only when `accepted`. */
    draft: draftSchema.optional(),
  })
  .strict();
export type PrepareApplicationOutput = z.infer<typeof prepareApplicationOutputSchema>;

export const prepareApplicationToolDescription =
  "Hand over one application's preparation for checking. Pass the taskId exactly as given, an entry for every numbered requirement (covered, with the labels of the confirmed claims that meet it; gap, with one short question for the person; left_out, only where the person said so; or not_a_requirement), and the draft: resume sections whose every sentence ends with the labels of the confirmed claims it states, like [C1], and the cover letter when one was asked for. If any requirement is a gap, send no draft. The runner checks every sentence; if it refuses, fix exactly what it names and call again with the whole draft. Nothing is saved until the turn ends.";

/** The last completed, non-error `prepare_application` result in `events` for this task and attempt. Undefined when there is none. */
export function preparationResult(events: readonly MessageStreamEvent[], taskId: string, attemptId: string): PrepareApplicationOutput | undefined {
  return preparationCall(events, taskId, attemptId)?.output;
}

/**
 * The last completed, non-error `prepare_application` call in `events` for
 * this task and attempt: its result, and the input the model sent with it
 * (matched by call id; undefined if the request isn't among the events).
 */
export function preparationCall(
  events: readonly MessageStreamEvent[],
  taskId: string,
  attemptId: string,
): { readonly input: PrepareApplicationInput | undefined; readonly output: PrepareApplicationOutput } | undefined {
  const inputs = new Map<string, unknown>();
  let found: { input: PrepareApplicationInput | undefined; output: PrepareApplicationOutput } | undefined;
  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) if ("toolName" in action && action.toolName === PREPARE_APPLICATION_TOOL) inputs.set(action.callId, action.input);
      continue;
    }
    if (event.type !== "action.result" || event.data.status !== "completed") continue;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== PREPARE_APPLICATION_TOOL || result.isError) continue;
    const output = prepareApplicationOutputSchema.safeParse(result.output);
    if (!output.success || output.data.taskId !== taskId || output.data.attemptId !== attemptId) continue;
    const input = prepareApplicationInputSchema.safeParse(inputs.get(result.callId));
    found = { input: input.success && input.data.taskId === taskId ? input.data : undefined, output: output.data };
  }
  return found;
}

/** A tool or action a turn asked for, by kind and name. */
export interface RequestedAction {
  readonly kind: string;
  readonly name: string;
}

/** Every action a turn's model requested (`actions.requested`) and every tool result it got (`action.result`). */
export function requestedActions(events: readonly MessageStreamEvent[]): RequestedAction[] {
  const actions: RequestedAction[] = [];
  for (const event of events) {
    if (event.type === "actions.requested") {
      for (const action of event.data.actions) {
        let name: string;
        if ("toolName" in action) name = action.toolName;
        else if ("subagentName" in action) name = action.subagentName;
        else if ("remoteAgentName" in action) name = action.remoteAgentName;
        else name = "load_skill";
        actions.push({ kind: action.kind, name });
      }
    } else if (event.type === "action.result") {
      const result = event.data.result as { readonly kind: string; readonly toolName?: string };
      if (result.kind === "tool-result" && result.toolName) actions.push({ kind: "tool-result", name: result.toolName });
    }
  }
  return actions;
}

/** Actions outside a preparation's own tools: a subagent, a remote agent, or any tool but `prepare_application` and `load_skill`. */
export function actionsOutsidePreparation(events: readonly MessageStreamEvent[]): RequestedAction[] {
  return requestedActions(events).filter((action) => {
    if (action.kind === "load-skill") return false;
    if (action.kind === "tool-call" || action.kind === "workflow-tool-call" || action.kind === "tool-result") return !PREPARATION_TOOL_NAMES.includes(action.name);
    return true;
  });
}
