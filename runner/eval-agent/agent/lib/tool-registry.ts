/**
 * The eval agent's exact tool surface: P02's base list, then each later
 * packet's explicit addition, one constant per packet. `tool-surface.eval.ts`
 * asserts the running agent offers exactly `REGISTERED_TOOLS` (sorted, the
 * same way `fixture-model.ts`'s inventory handler sorts
 * `request.tools.map((tool) => tool.name)`). A later packet adds a tool by
 * adding an entry to its own constant here — this file, never
 * `tool-surface.eval.ts` again after P03's one-time setup (see that file's
 * comment) — and never by deriving the list from a runtime scan of
 * `agent/tools/`, which would silently accept an unregistered tool.
 */
export const P02_TOOLS = ["load_skill", "open_application_group"] as const;

/** extract_claims (claim-extraction) and ask_follow_up (follow-up-questions). */
export const P03_TOOLS = ["ask_follow_up", "extract_claims"] as const;

/** extract_job (job capture's structured extraction, mirroring P03's extract_claims). */
export const P04_TOOLS = ["extract_job"] as const;

export const REGISTERED_TOOLS: readonly string[] = [...P02_TOOLS, ...P03_TOOLS, ...P04_TOOLS].sort();
