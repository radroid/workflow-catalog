# Blocks log

Structured record of everything the autonomous loop would otherwise halt on: sub-agent block verdicts, peer-review request_changes, smoke failures, contract drift, user-decision blockers, arch-pass results. Blocks keep the loop moving: a block becomes an entry here and the loop picks the next non-conflicting item.

Each entry follows this format:

```markdown
## YYYY-MM-DD — <short title> [APPROVE|REQUEST_CHANGES|BLOCK|FAILURE|DRIFT]

**Iter:** NNN
**Source:** peer-review | arch-pass | smoke-failure | mcp-preflight | user-report | contract-drift
**Severity:** low | medium | high

**Charter / context:** <one line>
**Verdict text / failure detail:** <body>

**Action taken:** <main agent's response>
```

(no entries yet)
