import { defineSandbox, type SandboxBackend } from "eve/sandbox";

// The runner has no sandbox. agent.ts sets `defaultTools: false`, so there is
// no bash, read_file or write_file tool that could use one, and the mounted
// skills are static SKILL.md files that load_skill returns without a sandbox
// (eve docs, skills.mdx).
//
// Without this file eve would pick defaultBackend(): Docker when a daemon is
// reachable, then microsandbox, then just-bash. That is a real shell on the
// person's machine the moment any code asks for a sandbox. This backend
// refuses instead, with a message that says why, so a future tool that calls
// ctx.getSandbox() fails closed. It is not justbash(): that would need the
// just-bash package, which `eve start` does not install, and it would give a
// shell with no network isolation.
const noSandbox: SandboxBackend = {
  name: "workflow-catalog-no-sandbox",
  async prewarm() {
    return { reused: true };
  },
  async create() {
    throw new Error(
      "The job-assistant runner has no sandbox: it exposes no shell or file tools. A tool that needs one must be reviewed and given an explicit backend in runner/agent/sandbox/sandbox.ts.",
    );
  },
};

export default defineSandbox({ backend: noSandbox });
