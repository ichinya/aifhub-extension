# Implementation Guide (AIF Implement+)

## Plan Discovery (`--list`)

Expected output shape:

```text
Available plans:

1) <plan-id>
   Title: <title>
   Status: <status>
   Progress: <completed>/<total>
   Updated: <timestamp>

Usage:
- /aif-implement <plan-id>
- /aif-implement @.ai-factory/plans/<plan-id>
- /aif-implement status
```

Behavior:
- read-only
- no status updates
- no code changes

## Task Execution Loop

For each task:

1. set `in_progress`
2. implement
3. quick local verify
4. mark completed
5. update checkbox
6. sync progress counters

## Verify/Fix Loop

After all tasks:

1. run quality checks
2. run `/aif-verify`
3. on FAIL run `/aif-fix`
4. run `/aif-verify` again
5. repeat until PASS or loop limit
