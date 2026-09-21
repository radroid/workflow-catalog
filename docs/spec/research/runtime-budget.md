# Runtime budget: can the pilot fit $25/month hosted, and what does inference cost?

Research date: 2026-09-20. Compiled from five primary-source sub-reports (Vercel Hobby, OpenAI Codex/ChatGPT plans and API pricing, eve `chatgpt()`, Anthropic pricing and plan terms, Chrome Web Store and domains). Every number below is either quoted from the linked source or an explicit estimate labelled as such. Currency: USD before tax.

## 1. Vercel Hobby

- Price $0/month; "for personal, non-commercial use" ([pricing](https://vercel.com/pricing)). Fair use defines commercial as "any Deployment that is used for the purpose of financial gain of anyone involved in any part of the production of the project, including a paid employee or consultant writing the code" ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)). A five-person unpaid pilot with no payments or ads is inside that definition.
- Included monthly: 100 GB fast data transfer, 1M edge requests, 1M function invocations, 4 active CPU-hours, 360 GB-hours memory, 5,000 image transformations ([Hobby plan](https://vercel.com/docs/plans/hobby)). Functions max 300 s ([duration](https://vercel.com/docs/functions/configuring-functions/duration)).
- Over the limit, Hobby **pauses, it never bills**: "if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed before you can use the feature again" ([Hobby plan](https://vercel.com/docs/plans/hobby)).
- Cron: Hobby "limited to cron jobs that run once per day", precision ±59 min ([cron](https://vercel.com/docs/cron-jobs/usage-and-pricing)). The catalog needs no cron; all scheduling is in the local runner.
- Team: "Collaborating with other members on projects is available on the Pro and Enterprise plans" ([accounts](https://vercel.com/docs/accounts)). The owner is the only deployer, which is fine. Hobby cannot connect repos owned by a GitHub organisation ([limits](https://vercel.com/docs/limits)); `radroid/workflow-catalog` is a personal repo.
- Deployment Protection on Hobby allows only one external Vercel user and one shareable link ([Vercel Authentication](https://developer.chrome.com/docs/webstore/register)). So the catalog is **public at the Vercel layer and enforces invites in the app** (spec F1). Password Protection is Pro-only at $20/project/month.
- What would force Pro ($20/month + usage): commercial use, more than one external viewer via Vercel auth, cron more often than daily, a second dashboard collaborator. None are needed.

## 2. Storage and package hosting

- Vercel Postgres/KV are gone; Marketplace is the path. Neon free plan via the Marketplace: $0, 0.5 GB storage per project, 100 CU-hours, scale-to-zero after 5 min, compute suspended when exhausted ([Neon plans](https://neon.com/docs/introduction/plans), [Marketplace storage](https://vercel.com/docs/marketplace-storage)). Invites, sessions, and install status for five people is kilobytes.
- Vercel Blob: 1 GB, 10k simple operations, paused (not billed) over limit ([Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)). Not used: workflow package tarballs are GitHub Release assets ($0).

## 3. ChatGPT Plus and Codex (the $20 already paid)

- Plus is $20/month; Codex description: "Power a few focused coding sessions each week" ([Codex pricing](https://learn.chatgpt.com/docs/pricing)).
- Limits are estimates, not fixed counts. Plus local messages per rolling five-hour window: GPT-6 Astra 5–45, GPT-5.6 Sol 10–100, GPT-5.6 Terra 25–200, GPT-5.6 Luna 250–2,000. "Weekly limits may also apply" (number unpublished). Local and cloud share one allowance; Codex, Work, Excel and PowerPoint share the same agentic pool on Plus ([Codex pricing](https://learn.chatgpt.com/docs/pricing), [usage limits](https://help.openai.com/en/articles/20001516)).
- At the limit: the active turn may finish, then new turns stop until reset. Documented ways to continue: buy credits (prices "vary by account, region, and plan"; not published), buy an instant weekly reset (price not published), or "run extra local chats using an API key, with usage charged at standard API rates" ([Codex pricing](https://learn.chatgpt.com/docs/pricing), [credits](https://help.openai.com/en/articles/12642688), [resets](https://help.openai.com/en/articles/20001507)).
- Evidence from this project: the planning session that produced this map stopped at 10:47 today with "Codex usage limit reached. Send the message again once the limit resets." That was interactive planning, not an overnight loop.

## 4. eve `chatgpt()` (the runner's default provider)

- "Creates a language model billed to the local ChatGPT subscription instead of an API key… This model works in local dev and fails in a deployment." Requests go to `chatgpt.com/backend-api/codex/responses`; credentials come from the Codex CLI's app-server when installed, else eve's own OAuth with the refresh token in the OS keychain ([eve TypeScript API](https://eve.dev/docs/reference/typescript-api), [source](https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/public/models/openai/index.ts)).
- So the runner's inference **draws from the same Plus allowance as the person's own Codex use**. Which ChatGPT plans are eligible is **UNVERIFIED** (eve says only "enforced by the Codex backend per account"). Usage-limit responses have no special handling in eve: a 429 gets three attempts with backoff, then fails ([eve harness](https://github.com/vercel/eve/blob/d004e6d47e9d25d0380c24b5a47b65a18f8b2784/packages/eve/src/harness/tool-loop.ts)). The runner must treat that failure as "paused: provider limit".
- Terms: OpenAI's ChatGPT Terms prohibit sharing credentials, circumventing rate limits, and "using ChatGPT to power third-party services" ([Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)). Each person signs in to their own account on their own machine through eve's documented flow; nobody's credentials are shared or intermediated by the catalog. No OpenAI page was found that addresses non-official clients explicitly (**UNVERIFIED** either way).
- Anthropic, by contrast, is explicit: third-party tools must use API keys; routing through Pro/Max subscription credentials is not permitted ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). So the Anthropic option in the runner is API-key only.

## 5. API pricing per 1M tokens (input / cached input / output)

OpenAI, standard tier ([API pricing](https://developers.openai.com/api/docs/pricing)): gpt-6-astra $10 / $1 / $50; gpt-5.6-sol $4 / $0.40 / $20; gpt-5.6-terra $2 / $0.20 / $12; gpt-5.6-luna $0.20 / $0.02 / $1.20; gpt-5.4-mini $0.75 / $0.075 / $4.50; gpt-5.3-codex $1.75 / $0.175 / $14. Batch and Flex are half price.

Anthropic ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)): Claude Sonnet 5 $2 / $0.20 / $10; Claude Haiku 4.5 $1 / $0.10 / $5; Claude Opus 5 $5 / $0.50 / $25. Batch half price. Models from 4.7 on tokenise about 30% more tokens for the same text.

## 6. Chrome Web Store and domain

- Developer registration is a one-time fee; the amount is not printed in the docs ("in an amount determined in Google's sole discretion"); $5 is widely reported, **UNVERIFIED** from official text ([register](https://developer.chrome.com/docs/webstore/register)). 2-Step Verification and trader/non-trader declaration required.
- Private listing with trusted testers needs only plain Google accounts, no Workspace; review still applies to every visibility ([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)).
- Custom domain optional: roughly $9–15/year at cost-price registrars (Porkbun .com $11.08, .dev $12.87 renewal) ([Porkbun](https://porkbun.com/products/domains)). `*.vercel.app` is $0.

## Cost model

**A. Hosted operating cost per month (five-person pilot)**

| Line item | Cost | Free-tier ceiling | What would trigger a charge |
|---|---|---|---|
| Vercel Hobby (catalog) | $0 | 100 GB / 1M req / 1M invocations | Nothing: Hobby pauses instead of billing. Pro only if commercial, collaborators, or sub-daily cron |
| Neon Postgres (free, via Marketplace) | $0 | 0.5 GB, 100 CU-h | Upgrading the plan; not needed |
| GitHub Releases (package tarballs) | $0 | Public repo | — |
| Domain (optional) | $0 (`.vercel.app`) or ~$1/mo amortised | — | Buying one |
| Chrome Web Store registration | one-time, reported $5 | — | — |
| Uptime check (optional) | $0 (UptimeRobot free, 50 monitors) | — | — |
| **Recurring total** | **$0–1 / month** | | |

Ceiling $25: fits with the entire margin unused. There is no path on Hobby by which usage produces a bill.

**B. Inference cost per person per month**

Token assumptions (estimates, labelled as such): onboarding once = 4 documents ingested + ~10 follow-up turns ≈ 100k input / 15k output. Per application = requirements, matching, gap questions, resume, cover letter, one revision ≈ 40k input / 8k output. Applications per month: low 13 (3/week), typical 26 (6/week), high 43 (10/week). Prompt caching of the profile would lower input cost further; not assumed.

| Option | Low | Typical | High | Notes |
|---|---|---|---|---|
| ChatGPT Plus via `chatgpt()` (Luna default) | $0 extra | $0 extra | $0 extra | Draws on the Plus agentic allowance (Luna 250–2,000 msgs / 5 h); ~10 calls per application, so a daily run of 2–3 jobs is a small fraction of one window. Shared with the person's own Codex use. Plan eligibility UNVERIFIED |
| Own OpenAI key, gpt-5.6-luna | ~$0.25 | ~$0.50 | ~$0.75 | Cheapest; quality of drafting to be judged in the pilot |
| Own OpenAI key, gpt-5.6-terra | ~$2.30 | ~$4.60 | ~$7.60 | Likely drafting model if Luna is not good enough |
| Own OpenAI key, gpt-5.6-sol | ~$4.20 | ~$8.30 | ~$13.80 | |
| Own Anthropic key, Claude Haiku 4.5 | ~$1.40 | ~$2.70 | ~$4.50 | Includes the ~30% tokenizer uplift |
| Own Anthropic key, Claude Sonnet 5 | ~$2.70 | ~$5.40 | ~$9.00 | Includes the ~30% tokenizer uplift |
| Onboarding, one-time | Luna $0.04 · Terra $0.40 · Sol $0.70 · Sonnet 5 $0.45 | | | |

## Budget verdict

The hosted pilot fits $25/month with a $0 target; nothing on the chosen stack can bill the owner. Inference is each person's own: $0 extra on a ChatGPT Plus subscription through `chatgpt()`, or roughly $0.50–$9 per month on an API key depending on the model. Honest risks: (1) `chatgpt()` plan eligibility and its behaviour under `eve start` are undocumented; (2) the runner's usage competes with the person's own Codex allowance, so a friend who codes with Codex all day may hit limits the workflow did not cause; (3) Hobby's noncommercial rule means the day anyone is paid for this, the catalog moves to Pro ($20/month, still within the ceiling); (4) Chrome Web Store review timing is outside our control.

## Implications for the overnight build on a $20 Codex plan

- Plus is sized for "a few focused coding sessions each week", with a five-hour window and an unpublished weekly cap. An unattended multi-hour loop on GPT-6 Astra (5–45 messages per window on Plus) will stop early; on Terra (25–200) it may finish one to three packets per window. Today's limit hit during planning is the evidence.
- Therefore the loop must be **packet-bounded and resumable**: one packet per iteration, state committed at the packet boundary, "usage limit reached" treated as pause-until-reset, never as an error to retry.
- Ways to keep going, all documented by OpenAI: buy Codex credits, buy an instant weekly reset (prices unpublished), or `codex login --with-api-key` at standard API rates. Rough estimate (not a quote): an agentic packet on gpt-5.3-codex at ~3M mostly-cached input and ~300k output tokens is on the order of $5–8, so a ten-packet MVP is on the order of $50–80 in API credit if done entirely outside the subscription. That is a one-time build cost, separate from the $25 operating ceiling.
- Alternative: Claude Code on a Claude Pro ($20) or Max ($100) subscription has the same five-hour/weekly shape; Anthropic reports ~$13 per developer per active day at API rates, which is a fair proxy for an overnight run ([Claude Code costs](https://code.claude.com/docs/en/costs)).

## Sources

Vercel: [pricing](https://vercel.com/pricing) · [Hobby plan](https://vercel.com/docs/plans/hobby) · [fair use](https://vercel.com/docs/limits/fair-use-guidelines) · [limits](https://vercel.com/docs/limits) · [cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing) · [Marketplace storage](https://vercel.com/docs/marketplace-storage) · [deployment protection](https://vercel.com/docs/deployment-protection/usage-and-pricing) · [accounts](https://vercel.com/docs/accounts). Neon: [plans](https://neon.com/docs/introduction/plans). OpenAI: [Codex pricing](https://learn.chatgpt.com/docs/pricing) · [auth](https://learn.chatgpt.com/docs/auth) · [API pricing](https://developers.openai.com/api/docs/pricing) · [usage limits](https://help.openai.com/en/articles/20001516) · [credits](https://help.openai.com/en/articles/12642688) · [resets](https://help.openai.com/en/articles/20001507) · [Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers) · [Terms of Use](https://openai.com/policies/terms-of-use/). eve: [TypeScript API](https://eve.dev/docs/reference/typescript-api) · [agent config](https://eve.dev/docs/agent-config) · [dev TUI](https://eve.dev/docs/guides/dev-tui) · [source @ d004e6d](https://github.com/vercel/eve/tree/d004e6d47e9d25d0380c24b5a47b65a18f8b2784). Anthropic: [pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Claude Code costs](https://code.claude.com/docs/en/costs) · [plans](https://claude.com/pricing). Chrome: [register](https://developer.chrome.com/docs/webstore/register) · [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) · [remote code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code). Domains: [Porkbun](https://porkbun.com/products/domains) · [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/).
