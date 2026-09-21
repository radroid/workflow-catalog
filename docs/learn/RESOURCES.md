# Reviewing agent-built code and eve prompts: resources

## Knowledge

- [Google Engineering Practices: How to do a code review](https://google.github.io/eng-practices/review/reviewer/)
  The reviewer's standard: what to look for, how to navigate a change, speed, and how to write comments. Use for: the review loop in lesson 0001 and the checklist.
- [eve docs: agent configuration](https://eve.dev/docs/agent-config) · [repo copy](https://github.com/vercel/eve/blob/main/docs/agent-config.md)
  Where `defineAgent`, the model choice, and `chatgpt()` live. Use for: finding and changing the runner's model and top-level instructions.
- [eve docs: the dev TUI](https://eve.dev/docs/guides/dev-tui)
  `/login`, `/model`, local discovery, and the "ChatGPT subscription models are local-only" rule. Use for: running a prompt change interactively before committing.
- [eve docs: TypeScript API reference](https://eve.dev/docs/reference/typescript-api)
  Exact behaviour of `chatgpt()`, `openai()`, `anthropic()`, retries, and the deploy guard. Use for: any "why did the model call fail" question.
- [eve docs: self-hosting](https://github.com/vercel/eve/blob/main/docs/guides/deployment/self-hosting.md)
  Build/start path for running eve outside Vercel, which is what the local runner does. Use for: installer and doctor packets.
- [eve changelog](https://github.com/vercel/eve/blob/main/packages/eve/CHANGELOG.md)
  Read top-down when bumping the pinned version. Use for: lesson on upgrading eve.
- [Agent Skills specification](https://agentskills.io/specification)
  The portable `SKILL.md` format the workflow package uses. Use for: reviewing a skill file's frontmatter and structure.
- [OWASP Top 10 for LLM Applications: LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
  Why job postings and uploads are data, never instructions. Use for: reviewing any change to extraction prompts or the action allowlist.
- [Chrome extensions: remote-hosted code rules](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) · [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
  The two rules agents most often violate in extension code. Use for: reviewing extension packets.
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) · [fair use](https://vercel.com/docs/limits/fair-use-guidelines)
  What keeps the catalog at $0. Use for: reviewing anything that adds cron, storage, or team features.

## Wisdom (communities)

- [vercel/eve issues and discussions](https://github.com/vercel/eve/issues)
  Where breaking changes and workarounds surface first. Use for: "is this bug mine or eve's" before debugging for an hour.
- [Vercel community](https://community.vercel.com/)
  Hobby-plan edge cases and deployment questions.

## Gaps

- No high-trust primary source specifically on reviewing pull requests written by autonomous coding agents. Lesson 0001 adapts Google's reviewer guide and names the agent-specific failure modes from this project's own experience; revise once a better source exists.
- eve does not document which ChatGPT plans `chatgpt()` supports or how usage limits are signalled. Treat as unknown until observed.
