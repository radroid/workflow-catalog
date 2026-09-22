// `defaultTools: false` in agent.ts removes every optional built-in tool,
// load_skill included. Re-exporting it here is the documented way to add it
// back (eve docs, concepts/built-in-tools.md). It only returns a skill's
// instructions and adds no execution surface; the eval fixture proves it
// still loads the mounted job-assistant skills.
export { default } from "eve/tools/load_skill";
