/**
 * Everything in the runner's agent config except the model. agent/agent.ts
 * uses it with the model from settings; the eval fixture agent
 * (eval-agent/agent/agent.ts) uses it with a mockModel, so the evals exercise
 * this exact configuration.
 *
 * `defaultTools: false` turns off every optional built-in tool: bash,
 * read_file, write_file, web_fetch, web_search, todo, ask_question, agent and
 * task_cancel (eve docs, concepts/built-in-tools.md). The model can only reach
 * the tools authored under agent/tools/, where load_skill is added back.
 */
export const RUNNER_AGENT_OPTIONS = {
  defaultTools: false,
} as const;
